// Globals and constants
//
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		packets 	: [],
		name		: "",
		socketID	: undefined,
		shortages 	: 0,
		overflows 	: 0,
		newBuf 		: true,		
	}
}
var upstreamBuffer = []; 						// Audio packets coming down from our upstream server 
var oldUpstreamPacket = null;						// previous upstream packet kept in case more is needed
const maxBufferSize = 10;						// Max number of packets to store per client
const mixTriggerLevel = 3;						// When all clients have this many packets we create a mix
const packetSize = 500;								// Number of samples in the client audio packets
const SampleRate = 16000; 						// All audio in audence runs at this sample rate. 
const MaxOutputLevel = 1;						// Max output level for INT16, for auto gain control
var upstreamMixGain = 1;						// Gain applied to the upstream mix using auto gain control
var mixGain = 1;							// Gain applied to the mix sent upstream 
// Mix generation is done as fast as data comes in, but should keep up a rhythmn even if downstream audio isn't sufficient....
var nextMixTimeLimit = 0;						// The time the next mix must be sent is here:
var myServerName = process.env.servername; 				// Get servername from heroku config variable, if present
if (myServerName == undefined)
	myServerName ="";						// If this is empty it will be set when we connect upstream
var upstreamName = process.env.upstream; 				// Get upstream server from heroku config variable, if present
if (upstreamName == undefined)		
	upstreamName ="";						// If this is empty we will connect later when it is set



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

var io  = require('socket.io').listen(server, { log: false });		// socketIO for downstream connections

var upstreamServer = null;						// socket ID for upstream server if connected
var packetSequence = 0;							// Sequence counter for sending upstream
var upstreamServerChannel = -1;
var upstreamConnected = false;						// Flag to control sending upstream

function connectUpstreamServer(server) {				// Called when upstream server name is set
	upstreamServer = require('socket.io-client')(server);		// Upstream server uses client socketIO
	console.log("Connecting upstream to",server);
	upstreamServer.on('connect', function(socket){			// We initiate the connection as client
		console.log("upstream server connected ",server);
		upstreamName = server;
		upstreamServer.emit("upstreamHi",			// As client we need to say Hi 
		{
			"channel"	: upstreamServerChannel		// Send our channel (in case we have been re-connected)
		});
	});

	upstreamServer.on('channel', function (data) {			// The response to our "Hi" is a channel assignment
		if (data.channel > 0) {					// Assignment successful
			upstreamServerChannel = data.channel;
			if (myServerName == "") myServerName = "Channel " + upstreamServerChannel;
			console.log("Upstream server has assigned us channel ",upstreamServerChannel);
			upstreamConnected = true;
		} else {
			console.log("Upstream server unable to assign a channel");		
			console.log("Try a different server");		
			upstreamName = "no upstream server";
			upstreamServer.close();				// Disconnect and clear upstream server name
		}
	});

	// Audio coming down from our upstream server. It is a mix of audio from above and beside us in the server tree
	upstreamServer.on('d', function (packet) { 
		enterState( upstreamState );				// The task here is to build a mix
		upstreamIn++;						// and prepare this audio for sending
		let chan = packet.channels;				// to all downstream clients just like
		let mix = [];						// any other audio stream
		let ts = 0;
		for (let c=0; c < chan.length; c++) {			// So first we need to build a mix
			if (chan[c].socketID != upstreamServer.id) {	// Skip my audio in mix generation
				let a = chan[c].audio;
				if (mix.length == 0)			// First audio in mix goes straight
					for (let i=0; i < a.length; i++)
						mix[i] = a[i];
  				else
	  				for (let i=0; i < a.length; i++)
						mix[i] += a[i];		// Just add all audio together
			} else {					// This is my own data come back
				let now = new Date().getTime();
				ts = chan[c].timestamp;
				rtt = now - ts;				// Measure round trip time
			}
		}
		let obj = applyAutoGain(mix,upstreamMixGain,1);		// Bring mix level down if necessary
		upstreamMixGain = obj.finalGain;			// Store gain for next loop
		upstreamMax = obj.peak;					// For monitoring purposes
		if (mix.length != 0) {					// If there actually was some audio
			let p = {					// Construct the audio packet
				name		: "upstream",		// Give it an appropriate name
				audio		: mix,			// The audio is the mix just prepared
				peak		: obj.peak,		// Provide peak value to save effort
				timestamp	: ts,			// Maybe interesting to know how old it is?
				sequence	: 0,			// Not used
				channel		: 0,			// Upstream is assigned channel 0 everywhere
			}
			upstreamBuffer.push(p); 			// Store upstream packet in buffer
			if (upstreamBuffer.length > maxBufferSize) {	// Clip buffer if overflowing
				upstreamBuffer.shift();
				upstreamOverflows++;
			}
		}
		enterState( genMixState );
		generateMix();
		enterState( idleState );
	});

	upstreamServer.on('disconnect', function () {
		upstreamConnected = false;
		console.log("Upstream server disconnected.");
	});

}

// socket event and audio handling area
io.sockets.on('connection', function (socket) {
	console.log("New connection:", socket.id);

	socket.on('disconnect', function () {
		console.log("User disconnected:", socket.id);
		channels.forEach(c => {					// Find the channel assigned to this connection
			if (c.socketID == socket.id) {			// and free up its channel
				c.packets = [];
				c.name = "";
				c.socketID = undefined;
				shortages = 0,
				overflows = 0,
				c.newBuf = true;
				clientsLive--;
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
			for (let i=1; i < channels.length; i++) {	// else find the next available channel
				if ((channels[i] == null) || (channels[i].socketID === undefined)) {
					channel = i;			// assign fresh channel to this connection
					break;				// No need to look anymore
				}
			}
		}
		socket.emit('channel', { channel:channel });		// Send channel assignment result to client
		if (channel != -1) {					// Channel has been successfully assigned
			channels[channel].packets = [];			// Reset channel values
			channels[channel].name = "";
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

	socket.on('nus', function (data) {
		// A super has sent us a new upstream server to connect to
		console.log("New upstream server ",data["upstreamServer"]," from ", socket.id);
		connectUpstreamServer(data["upstreamServer"]);
	});

	socket.on('u', function (packet) { 				// Audio coming up from one of our downstream clients
		enterState( downstreamState );
		let channel = channels[packet.channel];			// This client sends their channel to save server effort
		channel.name = packet.name;				// Update name of channel in case it has changed
		channel.socketID = socket.id;				// Store socket ID associated with channel
		packet.socketID = socket.id;				// Also store it in the packet to help client
		channel.packets.push(packet);				// Add packet to its channel packet buffer
		if (channel.packets.length > maxBufferSize) {		// If buffer full, remove oldest item
			channel.packets.shift();
			channel.overflows++;				// Log overflows per channel
			overflows++;					// and also globally for monitoring
		}
		if (channel.packets.length >= mixTriggerLevel) 
			channel.newBuf = false;				// Buffer has filled enough. Channel can enter the mix
		packetsIn++;
		enterState( genMixState );
		generateMix();
		enterState( idleState );
	});
});


// Audio management, marshalling and manipulation code
//
//
function isTimeToMix() {						// Test if we must generate a mix regardless
	let now = new Date().getTime();
	if ((nextMixTimeLimit != 0) && (now >= nextMixTimeLimit))  {
		forcedMixes++;
		return true;
	} else
		return false;
}

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

// The main working function where audio marsahlling, mixing and sending happens
function generateMix () {
	let readyToMix = false;
	if (isTimeToMix()) readyToMix = true;
	else {								// It isn't time to mix. Is there enough to mix anyway?
		let allFull = true; 
		let fullCount = 0;		
		channels.forEach( c => {
			if (c.newBuf == false) {			// Check each non-new channel if it has enough audio
				if (c.packets.length > mixTriggerLevel) fullCount++;
				else allFull = false;
			}
		});							// If all non-new buffers are full enough lets mix!
		if ((fullCount >0) && (allFull == true)) readyToMix = true;
	}
	if (readyToMix) {
		let mix = new Array(packetSize).fill(0); 		// The mixed audio we will return to all clients
		let clientPackets = []; 				// All client audio packets that are part of the mix
		channels.forEach( c => {
			if (c.newBuf == false) {			// Ignore new buffers that are filling up
				let packet = c.packets.shift();		// Get first packet of audio
				if (packet == undefined) {		// If this client buffer has been emptied...
					c.shortages++;			// Note shortages for this channel
					shortages++;			// and also for global monitoring
				}
				else {					// Mix in audio. Mix is only for upstream server
					for (let i = 0; i < packet.audio.length; ++i) 
						mix[i] = (mix[i] + packet.audio[i]);	
					clientPackets.push( packet );	// Store packet of source audio 
				}
			}
		});
//		if (clientPackets.length <= 1)				// if zero or one active client left
//			nextMixTimeLimit = 0;				// stop sample timer - no sense in forcing mixes

		if (clientPackets.length != 0) {			// Only send audio if we have some to send
			if (upstreamConnected == true) { 		// Send mix if connected to an upstream server
				let obj = applyAutoGain(mix,mixGain,1);			// Adjust mix level 
				mixGain = obj.finalGain;				// Store gain for next mix auto gain control
				mixMax = obj.peak;					// For monitoring purposes
				let now = new Date().getTime();
				upstreamServer.emit("u", {
					"name"		: myServerName,			// Let them know which server this comes from
					"audio"		: mix,				// Level controlled mix of all clients here
					"sequence"	: packetSequence,		// Good for data integrity checks
					"timestamp"	: now,				// Used for round trip time measurements
					"peak" 		: obj.peak,			// Saves having to calculate again
					"channel"	: upstreamServerChannel,	// Send assigned channel to help server
				});
				packetSequence++;
				upstreamOut++;
				// As we have an upstream server is there any upstream audio to send downstream?
				if ((upstreamBuffer.length >= mixTriggerLevel) || (oldUpstreamPacket != null )) { 
					let upstreamPacket = [];			// Packet of upstream audio to send down
					if (upstreamBuffer.length == 0) { 		// if shortage of upstream audio
						upstreamShortages++;			// Log for monitoring purposes
						upstreamPacket = oldUpstreamPacket;	// use old audio packet rather than silence
					} else {
						upstreamPacket = upstreamBuffer.shift();// Get new packet from buffer
						oldUpstreamPacket = upstreamPacket;	// and store it in old buffer for future shortages
					}
					clientPackets.push( upstreamPacket ); 		// Add upstream audio packet to clients
				}
			} 
			io.sockets.in('downstream').emit('d', {		// Send all audio channels to all downstream clients
				"channels"	: clientPackets,
			});
			packetsOut++;					// Sent data so log it and set time limit for next send
			packetClassifier[clientPackets.length] = packetClassifier[clientPackets.length] + 1;
			if (nextMixTimeLimit == 0) {			// If this is the first send event then start at now
				let now = new Date().getTime();
				nextMixTimeLimit = now;
			}						// Next mix timeout is advanced forward by mix.length mS
			nextMixTimeLimit = nextMixTimeLimit + (packetSize * 1000)/SampleRate;
		} else nextMixTimeLimit = 0;				// No client packets so stop forcing and wait until more
	}
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
var upstreamShortages = 0;
var upstreamOverflows = 0;
var overflows = 0;
var shortages = 0;
var rtt = 0;
var clientsLive = 0;
var forcedMixes = 0;
var packetClassifier = [];
packetClassifier.fill(0,0,30);
var mixMax = 0;
var upstreamMax = 0;

const updateTimer = 10000;	// Frequency of updates to the console
function printReport() {
	enterState( idleState );					// Update timers in case we are inactive
	console.log(myServerName," Activity Report");
	console.log("Idle = ", idleState.total, " upstream = ", upstreamState.total, " downstream = ", downstreamState.total, " genMix = ", genMixState.total);
	console.log("Clients = ",clientsLive,"  Upstream In =",upstreamIn,"Upstream Out = ",upstreamOut,"Upstream Shortages = ",upstreamShortages," Upstream overflows = ",upstreamOverflows,"In = ",packetsIn," Out = ",packetsOut," overflows = ",overflows," shortages = ",shortages," forced mixes = ",forcedMixes," mixMax = ",mixMax," upstreamMax = ",upstreamMax," rtt = ",rtt);
	let cbs = [];
	for (let c in channels)
		cbs.push(channels[c].packets.length);
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
		"upShort":	upstreamShortages,
		"upOver":	upstreamOverflows,
		"overflows":	overflows,
		"shortages":	shortages,
		"forcedMixes":	forcedMixes,
		"cbs":		cbs,
		"pacClass":	packetClassifier,
		"upServer":	upstreamName
	});
	if ((overflows > 10) || (shortages > 10)) 
		if (maxBufferSize < 20) maxBufferSize += 3;		// If data is too variable boost buffer size
	if (maxBufferSize > 10) maxBufferSize--;			// nut regularly try to bring it back to normal
	packetClassifier.fill(0,0,30);
	packetsIn = 0;
	packetsOut = 0;
	upstreamIn = 0;
	upstreamOut = 0;
	upstreamShortages = 0;
	upstreamOverflows = 0;
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
