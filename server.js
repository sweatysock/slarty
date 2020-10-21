// Globals and constants
//
var zipson = require('zipson');						// For compressing and decompressing data
const SampleRate = 16000; 						// All audio in audence runs at this sample rate. 
const PacketSize = 500;							// Number of samples in the client audio packets
const maxBufferSize = 15;						// Max number of packets to store per client
const perfMaxBufferSize = 30;						// Max packets buffered for the performer
const mixTriggerLevel = 6;						// When all clients have this many packets we create a mix
const MaxOutputLevel = 1;						// Max output level for INT16, for auto gain control
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		packets 	: [],					// the packet buffer where all channel audio is held
		name		: "",					// name given by user or client 
		liveClients	: 0,					// Number of clients connected to this channel (>1 if a downstream server)
		group		: "",					// Group that channel belongs to. Starts empty to force joining "noGroup"
		socketID	: undefined,				// socket associated with this channel
		shortages 	: 0,					// for monitoring
		overflows 	: 0,					// for monitoring
		inCount		: 0,					// for monitoring
		newBuf 		: true,					// New buffers are left to build up to minTriggerLevel
		maxBufferSize	: maxBufferSize,			// Buffer max size unless recording
		mixTriggerLevel	: mixTriggerLevel,			// Minimum amount in buffer before forming part of mix
		recording	: false,				// Flags that all audio is to be recorded and looped
		playHead	: 0,					// Points to where we are reading from the buffer
		timestamp	: 0,					// The latest timestamp received from the client
		seq		: 0,					// Latest sequence number from client. For tracking losses.
		key		: null,					// The key used by this channel client to access this server
	}
}
var venue = {								// Venue audio data structure coming down from our upstream server
	packets 	: [],						// the packet buffer where venue audio is held
	name		: "Venue",					// name given to the venue channel
	liveClients	: 0,						// Number of clients connected to the venue in total
	group		: "",						// Group that channel belongs to. For the venue this is always "noGroup"
	socketID	: undefined,					// socket associated with this channel
	shortages 	: 0,						// for monitoring
	overflows 	: 0,						// for monitoring
	inCount		: 0,						// for monitoring
	newBuf 		: true,						// New buffers are left to build up to minTriggerLevel
	maxBufferSize	: maxBufferSize,				// Buffer max size unless recording
	mixTriggerLevel	: mixTriggerLevel,				// Minimum amount in buffer before forming part of mix
	recording	: false,					// Flags that all audio is to be recorded and looped
	playHead	: 0,						// Points to where we are reading from the buffer
}
var perf = {								// Performer data structure
	live	: false,						// Flag to indicate if we have performer is on air or not
	chan	: 0,							// Performer's channel if connected directly here (venue server = no upstream)
	packets	: [],							// Performer audio/video packet buffer. 
	streaming:false,						// Flag that indicates the performer buffer is full enough to start streaming
	inCount	: 0,							// For monitoring
}
var groups = [];							// Client group member lists indexed by group name
var defGroup = process.env.group;	 				// Get default group name from heroku config variable, if present
if (defGroup == undefined)						// This name is used to identify us upstream ony
	defGroup ="noGroup";						// If this is empty our users will not belong to any default group
var packetBuf = [];							// Buffer of packets sent upstream, subtracted from venue mix later
var venueSequence = 0;							// Sequence counter for venue sound going downstream
var upSequence = 0;							// Sequence counter for sending upstream
// Mix generation is done as fast as data comes in, but should keep up a rhythmn even if downstream audio isn't sufficient....
var nextMixTimeLimit = 0;						// The time the next mix must be sent 
var mixTimer = 0;							// Timer that triggers generateMix() if needed
var myServerName = process.env.servername; 				// Get servername from heroku config variable, if present
if (myServerName == undefined)						// This name is used to identify us upstream ony
	myServerName ="";						// If this is empty it will be set when we connect upstream
var reverbFile = process.env.reverbfile; 				// Get venue reverb file from heroku config variable, if present
if (reverbFile == undefined)						// This file gives the reverb vibe for the venue audio
	reverbFile ="";							// If this is empty the room will be dry as a bone
var simulating = process.env.simulating; 				// Get flag that tells us to simulate sound for load testing
if ((simulating != undefined) && (simulating == "true")) {		// It needs to be defined and set to "true" to engage simulation mode
	simulating = true;	
	console.log("SIMULATING SERVER");
}
else simulating = false;							
var loopback = process.env.loopback; 					// Get flag that tells us to be a loopback server
if ((loopback != undefined) && (loopback == "true")) {			// It needs to be defined and set to "true" to engage this mode
	loopback = true;	
	console.log("LOOPBACK SERVER MODE");
}
else loopback = false;						
var connectedClients = 0;						// Count of the number of clients connected to this server
const serverKey = "audenceServer";					// Key used to identify server with another server
var commands = {};							// Commands generated here or from upstream server

function addCommands(newCommands) {
	if (newCommands == undefined) return;
	if (newCommands.mute == true) commands.mute = true; else commands.mute = undefined;
	if (newCommands.gateDelay != undefined) commands.gateDelay = newCommands.gateDelay;
	if (newCommands.venueSize != undefined) commands.venueSize = newCommands.venueSize;
	if (newCommands.perfLevel != undefined) commands.perfLevel = newCommands.perfLevel;
	if (newCommands.noiseThreshold != undefined) commands.noiseThreshold = newCommands.noiseThreshold;
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

const request = require('request');					// Used to access RestAPI in audence.com

// Socket IO Client for upstream connections
//
//
var upstreamName = process.env.upstream; 				// Get upstream server from heroku config variable, if present
if (upstreamName == undefined)		
	upstreamName ="";						// If this is empty we will connect later when it is set
var upstreamServer = 							// Upstream server uses client version of socketIO
	require('socket.io-client')("https://"+upstreamName+".herokuapp.com/?key="+serverKey);		// Connect adding internal server key in query string
var upstreamServerChannel = -1;						// Channel assigned to us by upstream server
var upstreamConnected = false;						// Flag to control sending upstream

function connectUpstreamServer(server) {				// Called when upstream server name is set
	console.log("Connecting upstream to",server);
	var upstreamServer = require('socket.io-client')(server);	// Upstream server uses client socketIO
}

upstreamServer.on('connect', function(socket){				// We initiate the connection as client
	console.log("upstream server connected ",upstreamName);
	upstreamServer.emit("upstreamHi",				// As client we need to say Hi 
	{
		"channel"	: upstreamServerChannel,		// Send our channel (in case we have been re-connected)
		"key"		: serverKey,				// We are a server so we use the special server key
	});
});

upstreamServer.on('channel', function (data) {				// The response to our "Hi" is a channel assignment
	if (data.channel > 0) {						// Assignment successful
		upstreamServerChannel = data.channel;
		if (myServerName == "") myServerName = "Channel " + upstreamServerChannel;
		console.log("Upstream server has assigned us channel ",upstreamServerChannel);
		upstreamConnected = true;
		if (simulating) simulateSound();			// Once connected upstream we can start simulating
	} else {
		console.log("Upstream server unable to assign a channel");		
		console.log("Try a different server");		
		upstreamServer.close();					// Disconnect and retry soon
	}
});

// Venue audio coming down from our upstream server. Channels of audio from upstream plus all our peers.
upstreamServer.on('d', function (packet) { 
	if ( connectedClients == 0 ) return;				// If no clients no reason to process upstream data
	enterState( upstreamState );					
	upstreamIn++;						
	addCommands(packet.commands);					// Store upstream commands for sending downstream
	// 1. Gather performer audio and queue it up
	perf.live = packet.perf.live;					// Performer status is shared by all servers
	if (!perf.live) perf.streaming = false;				// Make sure we stop streaming perf audio if not live anymore
	if (packet.perf.packet != null) 				// If there is performer data buffer it
		perf.packets.push(packet.perf.packet);	
	if (perf.packets.length > perfMaxBufferSize)
		perf.packets.shift();					// Clip the performer buffer removing the oldest packet
	if ((!perf.streaming) && (perf.packets.length > 5)){		// If not streaming but enough perf data buffered
		perf.streaming = true;					// performer is now streaming from here
	}
	// 2. Subtract our buffered audio from venue mix sent from our upstream server
	let vData = packet.venue;					// Get the venue data from the packet
	let ts = 0;
	if (vData != null) {						// Check there is venue audio. It is not guaranteed 
		let mix = zipson.parse(vData.audio);			// Mix is the uncomrpessed MSRE audio that came from upstream
		venue.liveClients = vData.liveClients;			// Save the number of clients connected upstream in channel 0
		ts = vData.timestamps[upstreamServerChannel];		// Venue data also contains timestamps that allow rtt measurement
		let a8 = [], a16 = [];					// Will point to our audio MSRE blocks if there are any
		let s = vData.seqNos[upstreamServerChannel];		// Venue data comes with list of packet seq nos in mix. Get ours.
		if (s != null) {					// If our channel has a sequence number in the mix
			let a8 = [], a16 = [];				// We are going to look for our buffered packet audio
			while (packetBuf.length) {			// Scan our packet buffer for the packet with our sequence
				let p = packetBuf.shift();		// Remove the oldest packet from the buffer
				if (p.sequence == s) {			// We have found the right sequence number
					a8 = p.audio.mono8;		// Get our MSRE blocks from packet buffer
					a16 = p.audio.mono16;
					break;				// Packet found. Stop scanning the packet buffer. 
				}
			}
			let v8 = mix.mono8, v16 = mix.mono16;		// Shortcuts to the venue MSRE venue audio blocks
			if (v8.length > 0) {				// If there is venue audio it may need processing
				if (a8.length > 0) 			// Only subtract if our audio is not empty
					for (let i = 0; i < a8.length; ++i) v8[i] = v8[i] - a8[i];
				if ((v16.length > 0) && 		// Does venue and our audio have higher quality audio?
					(a16.length > 0)) 		// If so subtract our high bandwidth audio from venue
					for (let i = 0; i < a16.length; ++i) v16[i] = v16[i] - a16[i];
				mix = {mono8: v8, mono16: v16};		// Reconstruct the mix MSRE block with the subtracted audio
			} 					
		} 
	// 3. Build a venue packet 
		if (mix.mono8.length != 0) 				// Filter upstream audio to emulate distance
			mix.mono8 = midBoostFilter(mix.mono8);		// Just filter low sample rate part as it is a high pass filter
		let p = {						// Construct the audio packet
			name		: venue.name,			// Give packet our channel name
			audio		: mix,				// The audio is the uncompressed mix just prepared
			peak		: 0,				// This is calculated in the client.  
			liveClients	: venue.liveClients,		// Clients visible to upstream server = total venue capacity
			timestamp	: 0,				// Venue audio goes down but never returns so no rtt to measure
			sequence	: venueSequence++,		// Sequence number for tracking quality
			channel		: 0,				// Upstream is assigned channel 0 everywhere MARK
			sampleRate	: SampleRate,			// Send sample rate to help processing
			group		: "",				// Venue data doesn't go through group processing
		}
		// 4. Store the packet in the venue buffer
		venue.packets.push(p); 					// Store venue packet in venue buffer
		if (venue.packets.length > maxBufferSize) {		// Clip buffer if overflowing
			venue.packets.shift();
			venue.overflows++;
		}
		if (venue.packets.length >= venue.mixTriggerLevel) {
			venue.newBuf = false;				// Buffer has filled enough. Venue stream can enter the mix
		}
	} else console.log("NO VENUE PACKET IN DOWNSTREAM MESSAGE!");
	// 5. Generate the mix if there is enough audio buffered in all active channels
	enterState( genMixState );
	if (enoughAudio()) generateMix();				// If there is enough buffered in all other channels generate mix
	enterState( idleState );
});

upstreamServer.on('disconnect', function () {
	venue.packets = [];
	venue.liveClients = 0;
	venue.socketID = undefined;
	venue.shortages = 0,
	venue.overflows = 0,
	venue.newBuf = true;
	upstreamConnected = false;
	console.log("Upstream server disconnected.");
});




// Downstream client socket event and audio handling area
//
io.sockets.on('connection', function (socket) {
	console.log("New connection:", socket.id);

	socket.on('disconnect', function () {
		console.log("User disconnected:", socket.id);
		for (ch in channels) {					// Find the channel assigned to this connection
			let c = channels[ch];				// and free up its channel
			if (c.socketID == socket.id) {
				if (perf.chan == ch) {			// If this was the performer channel stop performing
					perf.chan = 0;
					perf.live = false;
				}
				if (!c.recording) {			// If recording the channel remains unchanged
					let g = groups[c.group];	// Remove this channel from its group
					if (g != undefined) {		// if it was in one... (a quickly refreshed client won't be)
						let pos = g.liveChannels[ch];	// Get member position &
						g.members[pos] = null;		// leave the position vacant
						g.memberCount--;		// One less member of the group
						g.liveChannels[ch] = null;	// & remove channel from group's list of live channels
					}
					c.group = "";			// Set to empty to force rejoining default group
					c.packets = [];			// Clean out buffers etc. leaving channel clean
					c.name = "";
					c.liveClients = 1;
					c.socketID = undefined;
					c.shortages = 0,
					c.overflows = 0,
					c.newBuf = true;
					c.key = null;
					connectedClients--;		// One client less is connected now
				}
			}
		}
	});

	socket.on('upstreamHi', function (data) { 			// A downstream client or server requests to join
		console.log("New client ", socket.id," requesting channel ",data.channel," with key ",data.key);
		let key = data.key;					// Get the key sent from the client
		if (loopback) key = serverKey;				// If we are a loopback server use the internal key to skip tests
		let used = false;					// Start assuming the key is fresh
		if (key != serverKey)					// Unless this is an audence server scan to see if this key is already in use
			channels.forEach( (c) => {if (c.key == key) used = true});
		if (used) {						// If in use just don't reply to Hi message. Leave client hanging.
			console.log("Client trying to connect with key ",key," already in use!");
//			return;
		}
		request('https://audence.com/lobby/keyCheck.php?key='	// Keys are confirmed with audence DB. 
					+key, { json: true }, (err, res, info) => { 
			let n = "zxzyz"+info.eventID+"-"+info.zone;	// Build server name associated with this key
			if ((key != serverKey) && 			// If the connection isn't from another audence server, and
				((!info.result) || (n != myServerName)))// if the key is bad or is meant for a different server
				return;					// don't reply to the message. Client will be left in limbo
			let requestedChannel = data.channel;		// If a reconnect they will already have a channel
			let channel = -1;				// Assigned channel. -1 means none (default response)
			if ((requestedChannel != -1) &&	(channels[requestedChannel].socketID === undefined)) {
				channel = requestedChannel;		// If requested channel is set and available reassign it
			} else {
				for (let i=1; i < channels.length; i++) {// else find the next available channel from 1 upwards
					if ((channels[i] == null) || (channels[i].socketID === undefined)) {
						channel = i;		// assign fresh channel to this connection
						break;			// No need to look anymore
					}
				}
			}
			if (channel != -1) {				// Channel has been successfully assigned
				channels[channel].packets = [];		// Reset channel values
				channels[channel].name = "";		// This will be set when data comes in
				channels[channel].liveClients = 0;	// Reset number of clients under this channel
				channels[channel].group = "";		// Empty group name forces joining default group
				channels[channel].socketID = socket.id;
				channels[channel].socket = socket;
				channels[channel].shortages = 0;
				channels[channel].overflows = 0;
				channels[channel].newBuf = true;		
				channels[channel].key = key;		// Store the key in the channel. Stops key reuse.
				socket.join(channels[channel].group);	// Add to default group for downstream data MARK CHECK THIS!!!!???
				connectedClients++;			// For monitoring purposes
				console.log("Client assigned channel ",channel);
			} else
				console.log("No channels available. Client rejected.");
			socket.emit('channel', { 			// Send channel assignment result to client
				channel	:channel, 
				reverb	:reverbFile,			// Also instruct the client to load the venue reverb 
				loopback:loopback,			// Let the client know if we are a loopback server
				defGroup:defGroup,			// Tell the client what their default group should be
				role	:data.type,			// Tell the client their role according to the audence DB
			});		
		});
	});

	socket.on('superHi', function (data) {				// A supervisor is registering for status updates PROTECT
		console.log("New super ", socket.id);
		socket.join('supers');					// Add them to the supervisor group
	});

	socket.on('commands', function (data) { 			// A super has sent us a new commands PROTECT
		addCommands(data);
	});

	socket.on('setPerformer', function (data) { 			// A super wants to set Performer channel PROTECT
		if (upstreamConnected) 		 			// upstream server means this not venue server so no performer
			return;
		if ((perf.live) 				  	// If performer is already set and is connected 
			&& (channels[perf.chan].socketID != undefined)){	// communicate they are no longer live
			channels[perf.chan].socket.emit("perf", {live:false});
			channels[perf.chan].packets = [];		// Reset the channel so that it buffers up again
			channels[perf.chan].newBuf = true;
		}
		perf.chan = data.channel;
		if ((perf.chan > 0) 					// If we have a valid performer channel that is connected
			&& (channels[perf.chan].socketID != undefined))	{
			channels[perf.chan].socket.emit("perf", {live:true}); // Inform the client they are on air
			perf.live = true;				// Performer is live. This will go to all servers & clients
			perf.streaming = false;				// But not streaming yet. Have to buffer some packets first
			perf.packets = [];				// Empty the packet queue for good measure
		} else {
			perf.live = false;				// Not a valid performer channel so reset variables
			perf.chan = 0;
			perf.packets = [];
			perf.streaming = false;
		}
	});

	socket.on('u', function (packet) { 				// Audio coming up from one of our downstream clients
		enterState( downstreamState );
		if (clientPacketBad(packet)) {
			console.log("Bad client packet");
			return;
		}
		let channel = channels[packet.channel];			// This client sends their channel to save server effort
		channel.name = packet.name;				// Update name of channel in case it has changed
		channel.liveClients = packet.liveClients;		// Store the number of clients behind this channel
		channel.timestamp = packet.timestamp;			// Store this latest timestamp for the client to measure rtt
		channel.socketID = socket.id;				// Store socket ID associated with channel
		packet.socketID = socket.id;				// Also store it in the packet to help client skip own audio
		if (packet.sequence != (channel.seq + 1)) 
			console.log("Channel ",packet.channel," incoming has jumped ",(packet.sequence - channel.seq)," packets");
		channel.seq = packet.sequence;
		if (loopback) {						// Loopback mode means treating everyone like a performer
			perf.chan = packet.channel;			// Set this channel as the performer for as long as it takes to return their packet
			perf.live = true;				// In loopback you are always live!
			perf.streaming = true;				// There is ony one packet going out, but that's ok.
			perf.packets.push(packet);			// Store performer audio/video packet
			generateMix();					// There is one performer packet. Send it now.
			perf.channel = 0;				// Unset the performer channel immediately
			return;						// Nothing more to do for loopback
		}
		if (channel.group != packet.group) {			// If the user has changed their group then...
			socket.leave(channel.group);			// leave the group they were in at a socket io level
			let g = groups[channel.group];			// Note the group they are currently in 
			if (g != null) { 				// If the group exists (at the start it won't)
				let pos = g.liveChannels[packet.channel];	// get the position held in the group
				g.members[pos] = null;			// leave that position vacant for the next one who joins
				g.memberCount--;			// One less member of the group - count is used to skip empty groups
				g.liveChannels[packet.channel] = null;	// and indicate that this channel is no longer active in the group
			} 
			channel.group = packet.group;			// update the group this channel now belongs to
			socket.join(channel.group);			// and join this new group
			g = groups[channel.group];			// Note the group we wish to join
			if (g == null) {				// If first member of group the entry will be null
				groups[channel.group] = {		// Create object containing a member position list and live channel list 
					members:[packet.channel],	// This channel is the first member in position 0
					memberCount:1,			// So the member count is obviously 1
					liveChannels:[],		// This list uses channel number as its index and holds the member number
				};					// so now set our channel live and indicate we are in position 0
				groups[channel.group].liveChannels[packet.channel] = 0;
			} else {					// The group exists already. Need to find a place to sit...
				for (let i=0; i<g.members.length+1; i++) {// Run through the list of group members
					if (g.members[i] == null) {		// Find an empty position slot,
						g.members[i] = packet.channel;	// assign it to our channel, 
						g.memberCount++;		// increase the member count for this group
						g.liveChannels[packet.channel] = i;	// and store our member positon in the live channel list
						break;				// No need to look anymore
					}
				}
			}
		}							// Finished handling group changes.
		if (packet.channel == perf.chan) { 			// This is the performer. Note: Channel 0 comes down in 'd' packets
			perf.inCount++;					// For monitoring
			perf.packets.push(packet);			// Store performer audio/video packet
			if (perf.packets.length > perfMaxBufferSize) {
				perf.packets.shift();			// Clip the performer buffer removing the oldest packet
//console.log("PERFORMER OVERflow for channel ",packet.channel);
			}
			if ((!perf.streaming) && (perf.packets.length > mixTriggerLevel)) {
				perf.streaming = true;			// If not streaming but enough now buffered, performer is go!
				nextMixTimeLimit = 0;			// Reset the mix timer so that it doesn't empty the buffer right away
			}
		} else {						// Normal audio: buffer it, clip it, and mix it 
			channel.packets.push(packet);			// Add packet to its channel packet buffer
			channel.recording = packet.recording;		// Recording is used for testing purposes only
			if ((channel.packets.length > channel.maxBufferSize) &&	
				(channel.recording == false)) {		// If buffer full and we are not recording this channel
				channel.packets.shift();		// then remove the oldest packet.
				channel.overflows++;			// Log overflows per channel
//console.log("OVERflow for channel ",packet.channel);
				overflows++;				// and also globally for monitoring
			}
			if (channel.packets.length >= channel.mixTriggerLevel) {
				channel.newBuf = false;			// Buffer has filled enough. Channel can enter the mix
			}
		}
		packetsIn++;
		channel.inCount++;
		enterState( genMixState );
		if (enoughAudio()) 
			generateMix();					// If there is enough audio in all active channels build mix
		enterState( idleState );
	});
});

function clientPacketBad(p) {						// Perform basic checks on packets to stop basic hacks
	if (p.audio.mono8 === undefined) return true;
	if (p.audio.mono16 === undefined) return true;
	if (p.name === undefined) return true;
	if (p.name == "") return true;
	if (p.channel === undefined) return true;
	if (p.liveClients === undefined) return true;
	if (p.group === undefined) return true;
	if (p.group == "") return true;
	return false;
}

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

var prevFilt1In = 0;							// Save last in & out samples for high pass filter
var prevFilt1Out = 0;
function midBoostFilter(audioIn) {					// Filter to boost mids giving distant sound
	if (isNaN(prevFilt1In)) prevFilt1In = 0;
	if (isNaN(prevFilt1Out)) prevFilt1Out = 0;
	let out1 = [];							// The output of the first filter goes here
	let alpha = 0.88888889; 					// First filter is a simple high pass filter
	out1[0] = (prevFilt1Out + audioIn[0] - prevFilt1In) * alpha;	// First value uses previous filtering values
	for (let i=1; i<audioIn.length; i++)				// The rest are calculated the same way
		out1[i] = (out1[i-1] + audioIn[i] - audioIn[i-1]) * alpha;
	prevFilt1In = audioIn[audioIn.length-1];			// Save last input sample for next filter loop
	prevFilt1Out = out1[out1.length-1];				// and last output sample for same reason
	return out1;							// Testing with just the high pass filter
}

function forceMix() {							// The timer has triggered a mix 
	forcedMixes++;							// Note how many times the timer forces a mix for monitoring
	if (simulating) simulateSound();				// If we are in simulation mode generate sound now
	generateMix();							// We need to push out a mix
}

function enoughAudio() {						// Is there enough audio to build a mix before timeout?
	let now = new Date().getTime();
	if (now > nextMixTimeLimit) {
		return true;						// If timer has failed to trigger just generate the mix now
	}
else return false;
	let allFull = true; 
	let fullCount = 0;		
	for (let ch=0; ch<channels.length; ch++) {
		let c = channels[ch];
		if ((!c.newBuf) && 					// Only consider buffers that are non-new (have reached trigger level)
			((perf.chan == 0) || (perf.chan != ch))) {	// Ignore the performer channel (if it is 0 then there is no performer)
			if (c.packets.length > c.mixTriggerLevel) 	// if there is enough audio buffered
				fullCount++;				// If so then add to count of full channels
			else allFull = false;				// if not then at least one channel isn't ready to be mixed
		}
	}
	if (perf.live) {						// If we are in performer mode
		if (perf.packets.length > mixTriggerLevel)		// check if the performer buffer has enough 
			fullCount++;					// If it does then lets go
		else							// Otherwise lets not mix just yet
			allFull = false;
	}
	if (!venue.newBuf) {						// If the venue has started streaming
		if (venue.packets.length > mixTriggerLevel)		// check if the venue buffer has enough too
			fullCount++;					// If it does then lets go
		else							// Otherwise lets not mix just yet
			allFull = false;
	}
	if ((fullCount >0) && (allFull == true)) {			// If there is at least one channel buffered and none short
		clearTimeout( mixTimer );				// We must be ahead of the timer so cancel it
		return true;						// and the mix can go ahead
	} else return false;						// otherwise ñets not mix and wait for channels to buffer more
}

var nextClap = 0;							// When to simulate next clap
var clapPeriod = 400;							// mS between claps
var clapVariance = 100;							// mS of variance between claps
var emptyPacket = {							// Simulate empty audio
	name		: "SIM",		
	audio		: {mono8:[],mono16:[],mono32:[],stereo8:[],stereo16:[],stereo32:[]},
	perfAudio	: false,	
	liveClients	: 1,
	sequence	: 0,	
	channel		: 1,		
}
function genClap8() {
	let clap8=[];
	let a=1
	let b=0
	for (let i=0;i<250;i++) {
		b=(a-b)/2;
		clap8[i] = ((Math.random() * 2) -1)*((a*b)/i);
	}
	console.log("clap samples:");
	console.log(clap8);
	return clap8;
}
var clapPacket = {							// Simulate a clap sound
	name		: "SIM",		
	audio		: {mono8:genClap8(),mono16:[],mono32:[],stereo8:[],stereo16:[],stereo32:[]},
	perfAudio	: false,	
	liveClients	: 1,
	sequence	: 0,	
	channel		: 1,		
}
function simulateSound() {						// Generate simulated clapping for load testing and venue sound shaping
	if (channels[1].name == "") {					// If this is the first time we are called, set up channel 1 for simulation
		channels[1].name = "SIM";
		channels[1].group = "noGroup";
		channels[1].newBuf = false;
		channels[1].packets.push(clapPacket);			// Add clap packet to channel packet buffer
		channels[1].packets.push(emptyPacket);			// followed by some quiet to fill buffer a little
		channels[1].packets.push(emptyPacket);			
		channels[1].packets.push(emptyPacket);		
		channels[1].packets.push(emptyPacket);	
		mixTimer = setTimeout(forceMix,(100));			// Kick off simulation with an artificial call to force mix in 100mS
	}
	let now = new Date().getTime();
	if (nextClap < now) {
console.log("clap");
		nextClap = Math.round(now + clapPeriod + Math.random() * clapVariance);
		channels[1].packets.push(clapPacket);			// Add clap packet to channel packet buffer
	} else
		channels[1].packets.push(emptyPacket);			// Else add quiet packet
	// APPLY THRESHOLDS ETC HERE TO REALLY SIMULATE VENUE SOUND & IT'S ISSUES
}


// The main working function where audio marshalling, venue mixing and sending up and downstream happens
// Six steps: 1. Prep performer audio 2. Build mix and colate group data 3. Send mix upstream + 3.1. Build venue mix 4. Send to all groups of clients & 5. Clean up & set timers
function generateMix () { 
	// 1. Get perf packet if performing and enough perf audio buffered to start streaming
	let p = {live:perf.live, chan:perf.chan, packet:null};		// Send downstream by default a perf object with no packet
	if (perf.streaming) {						// If the performer is streaming ...
		if (perf.packets.length > 0) {				// pull a performer packet from its queue, if any, and
			p.packet = perf.packets.shift();		// add to performer data replacing the null packet
			p.packet.timestamp = 
				channels[perf.chan].timestamp;		// Update the timestamp to the latest one recieved from the perf client
		} else perfShort++;					// Note performer shortages
	}
	// 1.5 Get venue packet if it is streaming
	let venuePacket = null;						// The channel 0 (venue) audio packet
	if ((!venue.newBuf) && (venue.packets.length > 0)) {		// If venue is streaming and there is data in its buffer
		venuePacket = venue.packets.shift();			// extract the oldest element in the buffer
	}
	// 2. Process all channels building group info. objects and generating a mix of all channels except 0 (upstream venue track) to send upstream
	let mono8 = new Array(PacketSize/2).fill(0);			// Mix of this server's audio to send upstream and also to add to venue track
	let mono16 = new Array(PacketSize/2).fill(0);			// It is in MSRE so there are two half-sized arrays to handle
	let someAudio8 = false, someAudio16 = false;			// Flags to indicate if there is any audio in these categories
	let seqNos = [];						// Array of packet sequence numbers used in the mix (channel is index)
	let timestamps = [];						// Array of packet timestamps used in the mix (channel is index)
	let clientPackets = [];						// Temporary store of all packets to send to all group members
	let packetCount = 0;						// Keep count of packets that make the mix for monitoring
	let totalLiveClients = 0;					// Count total clients live downstream of this server
	channels.forEach( (c, chan) => {				// Review all channels for audio and activity, and build server mix
		if (c.name != "") {					// Looking for active channels meaning they have a name
			if (chan != 0) totalLiveClients +=c.liveClients;// Sum all downstream clients under our active channels
			if ((c.group != "") && (clientPackets[c.group] == null)) {	// If this is the first channel for its' group
				clientPackets[c.group] = [];		// create an empty client packet buffer
			}
		}
		if (c.newBuf == false) {				// Build mix from channels that are non-new (buffering completed)
			let packet;
			if (c.recording) {				// If recording then read the packet 
				packet = c.packets[c.playhead];		// at the playhead position
				c.playhead++;				// and move the playhead forward
			} else
				packet = c.packets.shift();		// Take first packet of audio from channel buffer
			if (packet == undefined){			// If this client buffer has been emptied...
				if (chan!=perf.chan) {
					c.shortages++;			// Note shortages for this channel if not performer
					shortages++;			// and also for global monitoring
				}
				c.playhead = 0;				// Set buffer play position to the start
			}
			else if (packet.perfAudio == false) {		// Got data and not perfomer. Build mix of downstream channels. 
				packetCount++;				// Count how many packets have made the mix for tracing
				if (packet.audio.mono8.length > 0) {	// Unpack the MSRE packet of audio and add to server mix
					someAudio8 = true;
					for (let i = 0; i < packet.audio.mono8.length; ++i) mono8[i] += packet.audio.mono8[i];	
				}
				if (packet.audio.mono16.length > 0) {
					someAudio16 = true;
					for (let i = 0; i < packet.audio.mono16.length; ++i) mono16[i] += packet.audio.mono16[i];
				}
				seqNos[packet.channel] 			// Store the seq number of the packet just added to the mix
					= packet.sequence;		// so that it can be subtracted downstream to remove echo
				timestamps[packet.channel]		// Store the latest timestamp received from the client
					= c.timestamp;			// so that the sending client can measure its rtt
				if (c.group != "noGroup") {		// Store packet if part of a group. Used for client controlled mixing
					if (clientPackets[c.group] == null)
						console.log("Null group buffer for ",c.group);
					else {
						clientPackets[c.group].push( packet );	
					}
				}
			}
		}
	});
	// 3. Build server mix packet and send upstream if we have an upstream server connected. 
	if (!someAudio8) mono8 = [];					// If no audio send empty mix to save bandwidth
	if (!someAudio16) mono16 = [];					
	let mix = {mono8, mono16};					// Build audio block in MSRE format
	let zipMix = zipson.stringify(mix);				// Compress mixed audio to save BW for sending downstream
	mix = zipson.parse(zipMix);					// but uncompress for upstream and mixing with venue (it still saves 60% BW)
	if (upstreamConnected == true) { 				// Send mix if connected to an upstream server
		let now = new Date().getTime();
		let packet = {						// Build the packet the same as any client packet
			name		: myServerName,			// Let others know which server this comes from
			audio		: mix,				// Uncompressed mix of all downstream clients connected here
			perfAudio	: false,			// No performer audio ever goes upstream between servers
			liveClients	: totalLiveClients,		// Clients visible downstream of this server
			sequence	: upSequence++,			// Good for data integrity checks
			timestamp	: now,				// Used for round trip time measurements
			peak 		: 0,				// Calculated in the client
			channel		: upstreamServerChannel,	// Send assigned channel to help server
			recording	: false,			// Make sure the upstream server never records
			sampleRate	: SampleRate,			// Send sample rate to help processing
			group		: "noGroup",			// Not part of a group in upstream server
		};
		upstreamServer.emit('u',packet); 			// Send the packet upstream
		packetBuf.push(packet);					// Add sent packet to LILO buffer for echo cancelling 
		upstreamOut++;
	// 3.1. Now that mix has gone upstream complete venue audio for downstream by adding our mix to the venue packet if it exists
		if (venuePacket != null) {				// If we have venue audio from upstream
			let v8 = venuePacket.audio.mono8;		// Get the venue audio from upstream
			let v16 = venuePacket.audio.mono16;		// in MSRE format
			let m8 = mix.mono8, m16 = mix.mono16;		// and the mix we have just built too
			if (m8.length > 0) {				// Only combine venue and mix if there's mix audio
				if (v8.length > 0) {			// If there is venue audio add mix to venue
					for (let i = 0; i < v8.length; i++) v8[i] = v8[i] + m8[i];
				} else venuePacket.audio.mono8 = m8;	// else venue is silent so just use mix directly
			}						
			if (m16.length > 0) {		 		// If there is mix high band audio 
				if (v16.length > 0) {			// and venue high band audio then mix them
					for (let i = 0; i < v16.length; i++) v16[i] = v16[i] + m16[i];
				} else venuePacket.audio.mono16 = m16;	// otherwise just use the mix high band audio
			}
			venuePacket.seqNos = seqNos;			// Add to venue packet the list of seqNos 
			venuePacket.timestamps = timestamps;		// and timestamps that form part of the local venue mix
			venuePacket.audio = zipson.stringify(venuePacket.audio);	// Compress mixed venue audio before sending downstream
		} else {						// Temporarily no venue audio has reached us so generate a packet 
			venuePacket = {					// Construct the venue packet
				name		: "VENUE",		// Give packet temp venue name
				audio		: zipMix,		// Use our compressed mix as the venue audio
				seqNos		: seqNos,		// Packet sequence numbers in the mix
				timestamps	: timestamps,		// Packet timestamps in mix, so clients can measure their rtt
				liveClients	: venue.liveClients,	// Just is a temporary lack of audio. Use upstream value
				peak		: 0,			// This is calculated in the client
				timestamp	: 0,			// No need to trace RTT in downstream venue packets
				sequence	: venueSequence++,	// Sequence number for tracking quality
				channel		: 0,			// Upstream is assigned channel 0 everywhere MARK
				sampleRate	: SampleRate,		// Send sample rate to help processing
				group		: "",			// Venue data doesn't go through group processing
			}
		}
	} else {							// No upstream server connected so we must be the venue server
		venuePacket = {						// Construct the venue packet
			name		: "Venue",			// Give packet main venue name
			audio		: zipMix,			// Use our compressed mix as the venue audio
			seqNos		: seqNos,			// Packet sequence numbers in the mix
			timestamps	: timestamps,			// Packet timestamps in mix, so clients can measure their rtt
			liveClients	: totalLiveClients,		// Clients visible downstream of this server
			peak		: 0,				// This is calculated in the client.
			timestamp	: 0,				// No need to trace RTT in downstream venue packets
			sequence	: venueSequence++,		// Sequence number for tracking quality
			channel		: 0,				// Upstream is assigned channel 0 everywhere MARK
			sampleRate	: SampleRate,			// Send sample rate to help processing
			group		: "",				// Venue data doesn't go through group processing
		}
	} 
	// 4. Send packets to all clients group by group, adding performer, venue and group audio, plus group live channels and commands
	if ((loopback) && (channels[perf.chan].socketID != undefined)) {// If we are a loopback server and the performer has a socket ready
		io.to(channels[perf.chan].socketID).emit('d', {		// send the packet directly just to this client
			perf		: p,				// The same client's performer audio/video packet
			venue		: venuePacket,			// Venue audio packet. There should be none in this case
			channels	: [],				// In loopback there will be no other channels
			liveChannels	: [],				// nor other live channels
			commands	: commands,			// Send commands downstream as normal
		});
		p.packet = null;					// Stop timer acting
	} else for (group in groups) {					// Send packets to all active groups
		if (groups[group].memberCount == 0) continue;		// Skip empty groups
		let g = groups[group];
		let liveChannels = g.liveChannels;			// Get group specific live channels list for all members too
		io.sockets.in(group).emit('d', {			// Send to all group members group specific data
			perf		: p,				// Send performer audio/video packet + other flags
			venue		: venuePacket,			// Venue audio packet for special processing
			channels	: clientPackets[group],		// All channels in this group plus filtered upstream venue mix (in channel 0)
			liveChannels	: liveChannels,			// Include group member live channels with member position info
			commands	: commands,			// Send commands downstream to reach all client endpoints
		});
	}
	// 5. Trace, monitor and set timer for next marshalling point limit
	packetsOut++;							// Sent data so log it and set time limit for next send
	packetClassifier[packetCount] = packetClassifier[packetCount] + 1;
	clearTimeout(mixTimer);						// Mix generated. Clear forceMix timer if it is still pending
	if ((p.packet != null) || (packetCount > 0)) {			// if we have sent performer audio or other audio data set timer
		let now = new Date().getTime();				// Get time as this was when latest mix was sent out
		if (nextMixTimeLimit == 0) nextMixTimeLimit = now;	// If this is the first send event then start at now
		let f = 0;						// Timer period is adjusted subtly by f. 
		if (perf.streaming) {					// If the performer is live and streaming correctly
			f = perfMaxBufferSize/2 - perf.packets.length;	// Aim to keep its buffer perfectly in the middle
			f = f *3;					// Boost the rate of correction to keep closer control
		}							// to optimize sound quality
		nextMixTimeLimit += (PacketSize * (1000+f))/SampleRate;	// Next mix will be needed PacketSize samples in the future
		mixTimer = setTimeout(forceMix,(nextMixTimeLimit-now));	// Set forceMix timer for when next mix will be needed
	}
	else nextMixTimeLimit = 0;					// No data sent. No timer needed. Reset next mix target time
									// Things will start again when new data comes in.
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
var perfShort = 0;
var rtt = 0;
var forcedMixes = 0;
var packetClassifier = [];
packetClassifier.fill(0,0,30);
var mixMax = 0;

var tracecount = 1;

const updateTimer = 1000;						// Frequency of updates to the console
var counterDivider = 0;							// Used to execute operation 10x slower than the reporting loop
function printReport() {
	tracecount = 1;
	enterState( idleState );					// Update timers in case we are inactive
	let cbs = [];
	let cic = [];
	for (let c in channels) {
		let t = channels[c].packets.length;
		cbs.push(t);
		cic.push(channels[c].inCount);
		channels[c].inCount = 0;
	}
	io.sockets.in('supers').emit('s',{
		"server":	myServerName,
		"idle":		idleState.total,
		"upstream":	upstreamState.total,
		"downstream":	downstreamState.total,
		"genMix":	genMixState.total,
		"clients":	connectedClients,
		"in":		packetsIn,
		"out":		packetsOut,
		"upIn":		upstreamIn,
		"upOut":	upstreamOut,
		"upShort":	venue.shortages,
		"upOver":	venue.overflows,
		"overflows":	overflows,
		"shortages":	shortages,
		"perfShort":	perfShort,
		"forcedMixes":	forcedMixes,
		"cbs":		cbs,
		"cic":		cic,
		"pacClass":	packetClassifier,
		"upServer":	upstreamName,
		"perf":		perf.chan,
		"perfQ":	perf.packets.length,
		"perfIn":	perf.inCount,
		"perfStr":	perf.streaming,
	});
	perf.inCount = 0;
	channels.forEach(c => {
		c.shortages = 0;					// Reset channel-level counters
		c.overflows = 0;
	});
	packetClassifier.fill(0,0,30);
	packetsIn = 0;
	packetsOut = 0;
	upstreamIn = 0;
	upstreamOut = 0;
//	overflows = 0;
//	shortages = 0;
//	perfShort = 0;
	rtt = 0;
	forcedMixes = 0;
	mixMax = 99;
	if ((upstreamName != "") && (upstreamConnected == false)) {
		console.log("Connecting to upstream server",upstreamName);
		connectUpstreamServer(upstreamName);
	}
}
setInterval(printReport, updateTimer);



// We are all set up so let the idling begin!
enterState( idleState );
console.log(myServerName," IDLING...");
