// Globals and constants
//
const maxBufferSize = 10;						// Max number of packets to store per client
const mixTriggerLevel = 3;						// When all clients have this many packets we create a mix
const packetSize = 500;							// Number of samples in the client audio packets
const SampleRate = 16000; 						// All audio in audence runs at this sample rate. 
const MaxOutputLevel = 1;						// Max output level for INT16, for auto gain control
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		packets 	: [],					// the packet buffer where all channel audio is held
		name		: "",					// name given by user or client 
		socketID	: undefined,				// socket associated with this channel
		shortages 	: 0,					// for monitoring
		overflows 	: 0,					// for monitoring
		newBuf 		: true,					// New buffers are left to build up to minTriggerLevel
		maxBufferSize	: maxBufferSize,			// Buffer max size unless recording
		mixTriggerLevel	: mixTriggerLevel,			// Minimum amount in buffer before forming part of mix
		recording	: false,				// Flags that all audio is to be recorded and looped
		playHead	: 0,					// Points to where we are reading from the buffer
	}
}
var venueMixGain = 1;							// Gain applied to the upstream mix using auto gain control
var venueSequence = 0;							// Sequence counter for venue sound going downstream
var upstreamMixGain = 1;						// Gain applied to the mix sent upstream 
var upSequence = 0;							// Sequence counter for sending upstream
// Mix generation is done as fast as data comes in, but should keep up a rhythmn even if downstream audio isn't sufficient....
var nextMixTimeLimit = 0;						// The time the next mix must be sent is here:
var mixTimer = 0;							// Timer that triggers generateMix() if needed
var myServerName = process.env.servername; 				// Get servername from heroku config variable, if present
if (myServerName == undefined)						// This name is used to identify us upstream ony
	myServerName ="";						// If this is empty it will be set when we connect upstream
var commands = {};							// Commands generated here or from upstream server

function addCommands(newCommands) {
	if (newCommands.mute == true) commands.mute = true; else commands.mute = undefined;
	if (newCommands.gateDelay != undefined) commands.gateDelay = newCommands.gateDelay;
	if (newCommands.talkoverLevel != undefined) commands.talkoverLevel = newCommands.talkoverLevel;
	if (newCommands.talkoverLag != undefined) commands.talkoverLag = newCommands.talkoverLag;
	if (newCommands.outGain != undefined) commands.outGain = newCommands.outGain;
	if (newCommands.displayURL != undefined) commands.displayURL = newCommands.displayURL;
	if (newCommands.displayText != undefined) commands.displayText = newCommands.displayText;
}

// Network code
//
// Set up network stack and listen on ports as required
var fs = require('fs');
var express = require('express');
var app = express();
app.use(express.static('public'));
var PORT = process.env.PORT; 
if (PORT == undefined) {						// Not running on heroku so use SSL
	var https = require('https');
	var SSLPORT = 443; 
	var HTTPPORT = 80; 						// Only used for redirect to https
	var privateKeyPath = "./cert/key.pem"; 				// Temporary keys
	var certificatePath = "./cert/cert.pem"; 
	var privateKey = fs.readFileSync( privateKeyPath );
	var certificate = fs.readFileSync( certificatePath );
	var server = https.createServer({
    		key: privateKey,
    		cert: certificate
	}, app).listen(SSLPORT);
	var http = require('http');					// Redirect from http to https
	http.createServer(function (req, res) {
    		res.writeHead(301, { "Location": "https://" + req.headers['host'] + ":"+ SSLPORT + "" + req.url });
    		res.end();
	}).listen(HTTPPORT);
} else {								// On Heroku. No SSL needed
	var http = require('http');
	var server = http.Server(app);
	server.listen(PORT, function() {
		console.log("Server running on ",PORT);
	});
}

var io  = require('socket.io').listen(server, 
	{ cookie: false, log: false });					// socketIO for downstream connections



// Socket IO Client for upstream connections
//
//
var upstreamName = process.env.upstream; 				// Get upstream server from heroku config variable, if present
if (upstreamName == undefined)		
	upstreamName ="";						// If this is empty we will connect later when it is set
var upstreamServer = require('socket.io-client')(upstreamName);		// Upstream server uses client version of socketIO
var upstreamServerChannel = -1;
var upstreamConnected = false;						// Flag to control sending upstream

function connectUpstreamServer(server) {				// Called when upstream server name is set
	console.log("Connecting upstream to",server);
	var upstreamServer = require('socket.io-client')(server);	// Upstream server uses client socketIO
}

upstreamServer.on('connect', function(socket){				// We initiate the connection as client
	console.log("upstream server connected ",upstreamName);
	upstreamServer.emit("upstreamHi",				// As client we need to say Hi 
	{
		"channel"	: upstreamServerChannel			// Send our channel (in case we have been re-connected)
	});
});

upstreamServer.on('channel', function (data) {				// The response to our "Hi" is a channel assignment
	if (data.channel > 0) {						// Assignment successful
		upstreamServerChannel = data.channel;
		if (myServerName == "") myServerName = "Channel " + upstreamServerChannel;
		console.log("Upstream server has assigned us channel ",upstreamServerChannel);
		channels[0].name = "Venue";
		upstreamConnected = true;
	} else {
		console.log("Upstream server unable to assign a channel");		
		console.log("Try a different server");		
		upstreamName = "no upstream server";
		upstreamServer.close();					// Disconnect and clear upstream server name
	}
});

// Venue audio coming down from our upstream server. Channels of audio from upstream plus all our peers.
upstreamServer.on('d', function (packet) { 
	enterState( upstreamState );					// The task here is to build a mix
	upstreamIn++;							// and prepare this audio for sending
	let chan = packet.channels;					// to all downstream clients just like
	let mix = new Array(packetSize).fill(0); 			// any other audio stream
	let ts = 0;
	for (let c=0; c < chan.length; c++) {				// So first we need to build a mix
		if (chan[c].socketID != upstreamServer.id) {		// Skip my audio in mix generation
			let a = chan[c].audio;
  			for (let i=0; i < a.length; i++) mix[i] += a[i]	// Build mix. 
		} else {						// This is my own data come back
			let now = new Date().getTime();
			ts = chan[c].timestamp;
			rtt = now - ts;					// Measure round trip time
		}
	}
//	mix = midBoostFilter(mix);					// Filter upstream audio to made it distant
	let obj = applyAutoGain(mix,venueMixGain,1);			// Control mix audio level
	venueMixGain = obj.finalGain;					// Store gain for next loop
	upstreamMax = obj.peak;						// For monitoring purposes
	if (mix.length != 0) {						// If there actually was some audio
		let p = {						// Construct the audio packet
			name		: channels[0].name,		// Give packet our channel name
			audio		: mix,				// The audio is the mix just prepared
			peak		: obj.peak,			// Provide peak value to save effort
			timestamp	: ts,				// Maybe interesting to know how old it is?
			sequence	: venueSequence++,		// Sequence number for tracking quality
			channel		: 0,				// Upstream is assigned channel 0 everywhere
		}
		channels[0].packets.push(p); 				// Store upstream packet in channel 0
		if (channels[0].packets.length > maxBufferSize) {	// Clip buffer if overflowing
			channels[0].packets.shift();
			channels[0].overflows++;
		}
		if (channels[0].packets.length >= channels[0].mixTriggerLevel) 
			channels[0].newBuf = false;			// Buffer has filled enough. Channel can enter the mix
	}
	addCommands(packet.commands);					// Store upstream commands for sending downstream
	enterState( genMixState );
	if (enoughAudio()) generateMix();				// If there is enough audio buffered generate a mix
	enterState( idleState );
});

upstreamServer.on('disconnect', function () {
	channels[0].packets = [];
	channels[0].name = "";
	channels[0].socketID = undefined;
	channels[0].shortages = 0,
	channels[0].overflows = 0,
	channels[0].newBuf = true;
	upstreamConnected = false;
	console.log("Upstream server disconnected.");
});




// Downstream client socket event and audio handling area
//
io.sockets.on('connection', function (socket) {
	console.log("New connection:", socket.id);

	socket.on('disconnect', function () {
		console.log("User disconnected:", socket.id);
		channels.forEach(c => {					// Find the channel assigned to this connection
			if (c.socketID == socket.id) {			// and free up its channel
				if (!c.recording) {			// If recording the channel remains unchanged
					c.packets = [];			// so that audio can continue to be generated
					c.name = "";
					c.socketID = undefined;
					c.shortages = 0,
					c.overflows = 0,
					c.newBuf = true;
					clientsLive--;
				}
			}
		});
	});

	socket.on('upstreamHi', function (data) { 			// A downstream client requests to join
		console.log("New client ", socket.id);
		let requestedChannel = data.channel;			// If a reconnect they will already have a channel
		let channel = -1;					// Assigned channel. -1 means none (default response)
		if ((requestedChannel != -1) &&	(channels[requestedChannel].socketID === undefined)) {
			channel = requestedChannel;			// If requested channel is set and available reassign it
		} else {
			for (let i=1; i < channels.length; i++) {	// else find the next available channel from 1 upwards
				if ((channels[i] == null) || (channels[i].socketID === undefined)) {
					channel = i;			// assign fresh channel to this connection
					break;				// No need to look anymore
				}
			}
		}
		socket.emit('channel', { channel:channel });		// Send channel assignment result to client
		if (channel != -1) {					// Channel has been successfully assigned
			// MARK store sevrer URL and active channel info and URLs if provided
			channels[channel].packets = [];			// Reset channel values
			channels[channel].name = "";			// This will be set when data comes in
			channels[channel].socketID = socket.id;
			channels[channel].shortages = 0;
			channels[channel].overflows = 0;
			channels[channel].newBuf = true;		
			socket.join('downstream');			// Add to group for downstream data
			clientsLive++;					// For monitoring purposes
			console.log("Client assigned channel ",channel);
		} else
			console.log("No channels available. Client rejected.");
	});

	socket.on('superHi', function (data) {
		// A downstream server or client is registering with us
		// Add the downstream node to the group for notifications
		console.log("New super ", socket.id);
		socket.join('supers');
	});

	socket.on('commands', function (data) {
		// A super has sent us a new commands
		addCommands(data.commands);
	});

	socket.on('u', function (packet) { 				// Audio coming up from one of our downstream clients
		enterState( downstreamState );
		let channel = channels[packet.channel];			// This client sends their channel to save server effort
		channel.name = packet.name;				// Update name of channel in case it has changed
		channel.socketID = socket.id;				// Store socket ID associated with channel
		packet.socketID = socket.id;				// Also store it in the packet to help client
		channel.packets.push(packet);				// Add packet to its channel packet buffer
		channel.recording = packet.recording;
		if ((channel.packets.length > channel.maxBufferSize) &&	// If buffer full and we are not recording
			(channel.recording == false)) {			// the buffer then remove the oldest packet.
			channel.packets.shift();
			channel.overflows++;				// Log overflows per channel
			overflows++;					// and also globally for monitoring
		}
		if (channel.packets.length >= channel.mixTriggerLevel) 
			channel.newBuf = false;				// Buffer has filled enough. Channel can enter the mix
		packetsIn++;
		enterState( genMixState );
		if (enoughAudio()) generateMix();			// If there is enough audio buffered generate a mix
		enterState( idleState );
	});
});


// Audio management, marshalling and manipulation code
//
//
function maxValue( arr ) { 						// Find max value in an array
	let max = 0;
	let v;
	for (let i =  0; i < arr.length; i++) {
		v = Math.abs(arr[i]);
		if (v > max) max = v;
	}
	return max;
}

function applyAutoGain(audio, startGain, maxGain) {			// Auto gain control
	const MaxOutputLevel = 1;					// Max output level permitted
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	maxLevel = maxValue(audio);					// Find peak audio level 
	endGain = MaxOutputLevel / maxLevel;				// Desired gain to avoid overload
	maxLevel = 0;							// Use this to capture peak
	if (endGain > maxGain) endGain = maxGain;			// Gain is limited to maxGain
	if (endGain >= startGain) {					// Gain adjustment speed varies
		transitionLength = audio.length;			// Gain increases are gentle
		endGain = startGain + ((endGain - startGain)/10);	// Slow the rate of gain change
	}
	else
		transitionLength = Math.floor(audio.length/10);		// Gain decreases are fast
	tempGain = startGain;						// Start at current gain level
	for (let i = 0; i < transitionLength; i++) {			// Adjust gain over transition
		x = i/transitionLength;
		if (i < (2*transitionLength/3))				// Use the Magic formula
			p = 3*x*x/2;
		else
			p = -3*x*x + 6*x -2;
		tempGain = startGain + (endGain - startGain) * p;
		audio[i] = audio[i] * tempGain;
		if (audio[i] >= MaxOutputLevel) audio[i] = MaxOutputLevel;
		else if (audio[i] <= (MaxOutputLevel * -1)) audio[i] = MaxOutputLevel * -1;
		x = Math.abs(audio[i]);
		if (x > maxLevel) maxLevel = x;
	}
	if (transitionLength != audio.length) {				// Still audio left to adjust?
		tempGain = endGain;					// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++) {
			audio[i] = audio[i] * tempGain;
			if (audio[i] >= MaxOutputLevel) audio[i] = MaxOutputLevel;
			else if (audio[i] <= (MaxOutputLevel * -1)) audio[i] = MaxOutputLevel * -1;
			x = Math.abs(audio[i]);
			if (x > maxLevel) maxLevel = x;
		}
	}
	return { finalGain: endGain, peak: maxLevel };
}

var prevFilt1In = 0;							// Save last in & out samples for high pass filter
var prevFilt1Out = 0;
var filterBuf = [0,0];							// Keep previous two samples here for resonant filter
function midBoostFilter(audioIn) {					// Filter to boost mids giving distant sound
	let out1 = [];							// The output of the first filter goes here
	let alpha = 0.88888889; 					// First filter is a simple high pass filter
	out1[0] = (prevFilt1Out + audioIn[0] - prevFilt1In) * alpha;	// First value uses previous filtering values
	for (let i=1; i<audioIn.length; i++)				// The rest are calculated the same way
		out1[i] = (out1[i-1] + audioIn[i] - audioIn[i-1]) * alpha;
	prevFilt1In = audioIn[audioIn.length-1];			// Save last input sample for next filter loop
	prevFilt1Out = out1[out1.length-1];				// and last output sample for same reason
	let audioIn2 = out1;						// The output of the previous filter is the input of this
	let A = 1.25957111;						// Second filter is a high pass resonant filter
	let B = -0.4816372;						// Factors for the filter. Derived during design
	let C = 0.2220661;
	let out2 = [];							// Filter output goes here
	out2[0] = filterBuf[0];						// Restore values from previous filter session
	out2[1] = filterBuf[1];
	for (let i=0; i<audioIn2.length; i++)
		out2[i+2] = A * out2[i+1] + B * out2[i] + C * audioIn2[i];
	out2.splice(0,2);						// Remove first two elements from previous filter session
	filterBuf[0] = out2[out2.length-2];				// Store the last two filter values for next filter session
	filterBuf[1] = out2[out2.length-1];
	return out2;
}

function forceMix() {							// The timer has triggered a mix 
	forcedMixes++;
	generateMix();
}

function enoughAudio() {						// Is there enough audio to build a mix before timeout?
	let allFull = true; 
	let fullCount = 0;		
	channels.forEach( c => {
		if (c.newBuf == false) {				// Check each non-new channel if it has enough audio
			if (c.packets.length > c.mixTriggerLevel) fullCount++;
			else allFull = false;
		}
	});		
	if ((fullCount >0) && (allFull == true)) {
		clearTimeout( mixTimer );				// We are ahead of the timer, cancel it
		return true;						// All non-new buffers are full enough so lets mix!
	} else return false;
}



// The main working function where audio marsahlling, mixing and sending happens
function generateMix () {
	let mix = new Array(packetSize).fill(0); 			// The mixed audio we will return to all clients
	let clientPackets = []; 					// All client audio packets that are part of the mix
	channels.forEach( c => {
		if (c.newBuf == false) {				// Ignore new buffers that are filling up
			let packet;
			if (c.recording) {				// If recording then read the packet 
				packet = c.packets[c.playhead];		// at the playhead position
				c.playhead++;				// and move the playhead forward
			} else
				packet = c.packets.shift();		// Take first packet of audio from channel buffer
			if (packet == undefined) {			// If this client buffer has been emptied...
				c.shortages++;				// Note shortages for this channel
				shortages++;				// and also for global monitoring
				c.playhead = 0;				// Set buffer play position to the start
			}
			else {
				clientPackets.push( packet );		// Store packet of source audio for sending
				if (packet.channel != 0)		// Build mix for upstream server skipping its own audio
					for (let i = 0; i < packet.audio.length; ++i) mix[i] = (mix[i] + packet.audio[i]);	
			}
		}
	});
	if (clientPackets.length != 0) {				// Only send audio if we have some to send
		if (upstreamConnected == true) { 			// Send mix if connected to an upstream server
			let obj = applyAutoGain(mix,upstreamMixGain,1);	// Adjust mix level 
			upstreamMixGain = obj.finalGain;		// Store gain for next mix auto gain control
			mixMax = obj.peak;				// For monitoring purposes
			let now = new Date().getTime();
			upstreamServer.emit("u", {
				"name"		: myServerName,		// Let others know which server this comes from
				"audio"		: mix,			// Level controlled mix of all clients here
				"sequence"	: upSequence++,		// Good for data integrity checks
				"timestamp"	: now,			// Used for round trip time measurements
				"peak" 		: obj.peak,		// Saves having to calculate again
				"channel"	: upstreamServerChannel,// Send assigned channel to help server
				"recording"	: false,		// Make sure the upstream server never records
			});
			upstreamOut++;
		} 
		let liveChannels = [];					// build snapshot of current live client buffers
		for (let c in channels) 
			if (channels[c].name != "") {			// Means channel is connected to a client
				liveChannels[c] = {
					name	: channels[c].name,
					queue 	: channels[c].packets.length,
					// MARK ADD URL if there is one (only downstream servers have them)
					// MARK ADD peak level for each 
				}
			}
		io.sockets.in('downstream').emit('d', {			// Send all audio channels to all downstream clients
			"channels"	: clientPackets,
			"liveChannels"	: liveChannels,			// Include server info about live clients and their queues
			"commands"	: commands,			// Send commands downstream
			// MARK SEND our server URL
		});
		packetsOut++;						// Sent data so log it and set time limit for next send
		packetClassifier[clientPackets.length] = packetClassifier[clientPackets.length] + 1;
		let now = new Date().getTime();
		if (nextMixTimeLimit == 0) nextMixTimeLimit = now;	// If this is the first send event then start at now
		nextMixTimeLimit = nextMixTimeLimit + (packetSize * 1000)/SampleRate;
		mixTimer = setTimeout( forceMix, (nextMixTimeLimit - now) );	
	} else nextMixTimeLimit = 0;					// No client packets so stop forcing and wait for more data
}


// Reporting code. Accumulators, interval timer and report generator
// 

// Timing counters
//
// We use these to measure how many miliseconds we spend working on events
// and how much time we spend doing "nothing" (supposedly idle)
function stateTimer() {
	this.name = "";
	this.total = 0;
	this.start = 0;
}
var idleState = new stateTimer(); 	idleState.name = "Idle";
var upstreamState = new stateTimer();	upstreamState.name = "Upstream";
var downstreamState = new stateTimer();	downstreamState.name = "Downstream";
var genMixState = new stateTimer();	genMixState.name = "Generate Mix";
var currentState = idleState;		currentState.start = new Date().getTime();
function enterState( newState ) {
	let now = new Date().getTime();
	currentState.total += now - currentState.start;
	newState.start = now;
	currentState = newState;
}

// Accumulators for reporting purposes
//
var packetsIn = 0;
var packetsOut = 0;
var upstreamIn = 0;
var upstreamOut = 0;
var overflows = 0;
var shortages = 0;
var rtt = 0;
var clientsLive = 0;
var forcedMixes = 0;
var packetClassifier = [];
packetClassifier.fill(0,0,30);
var mixMax = 0;
var upstreamMax = 0;

const updateTimer = 1000;						// Frequency of updates to the console
var counterDivider = 0;							// Used to execute operation 10x slower than the reporting loop
function printReport() {
	enterState( idleState );					// Update timers in case we are inactive
	console.log(myServerName," Activity Report");
	console.log("Idle = ", idleState.total, " upstream = ", upstreamState.total, " downstream = ", downstreamState.total, " genMix = ", genMixState.total);
	console.log("Clients = ",clientsLive,"  Upstream In =",upstreamIn,"Upstream Out = ",upstreamOut,"Upstream Shortages = ",channels[0].shortages," Upstream overflows = ",channels[0].overflows,"In = ",packetsIn," Out = ",packetsOut," overflows = ",overflows," shortages = ",shortages," forced mixes = ",forcedMixes," mixMax = ",mixMax," upstreamMax = ",upstreamMax," rtt = ",rtt);
	let cbs = [];
	for (let c in channels) {
		let t = channels[c].packets.length;
		if (channels[c].newBuf == true) t = t + "n";
		cbs.push(t);
	}
	console.log("Client buffer lengths: ",cbs);
	console.log(packetClassifier);
	io.sockets.in('supers').emit('s',{
		"idle":		idleState.total,
		"upstream":	upstreamState.total,
		"downstream":	downstreamState.total,
		"genMix":	genMixState.total,
		"clients":	clientsLive,
		"in":		packetsIn,
		"out":		packetsOut,
		"upIn":		upstreamIn,
		"upOut":	upstreamOut,
		"upShort":	channels[0].shortages,
		"upOver":	channels[0].overflows,
		"overflows":	overflows,
		"shortages":	shortages,
		"forcedMixes":	forcedMixes,
		"cbs":		cbs,
		"pacClass":	packetClassifier,
		"upServer":	upstreamName
	});
	channels.forEach(c => {
		c.shortages = 0;					// Reset channel-level counters
		c.overflows = 0;
	});
	packetClassifier.fill(0,0,30);
	packetsIn = 0;
	packetsOut = 0;
	upstreamIn = 0;
	upstreamOut = 0;
	overflows = 0;
	shortages = 0;
	rtt = 0;
	forcedMixes = 0;
	mixMax = 99;
	upstreamMax = 99;
	if ((upstreamName != "") && (upstreamConnected == false)) {
		console.log("Connecting to upstream server",upstreamName);
		connectUpstreamServer(upstreamName);
	}
}
setInterval(printReport, updateTimer);



// We are all set up so let the idling begin!
enterState( idleState );
console.log(myServerName," IDLING...");
