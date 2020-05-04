//
// Launch parameters are -u upstream_server -d downstream server
// Multiple donstream servers can be specified but only one upstream is possible
//

// Globals and constants
//
function ClientBuffer() { 	// Object to buffer audio from a specific client
	this.clientID = 0;	// ID of the socket in the client and server
	this.packets = [];	// buffer of audio packets
}
var upstreamServer = null;	// socket ID for upstram server if connected
var upstreamBuffer = []; 	// Audio packets coming down from our upstream server 
var oldUpstreamBuffer = [];	// previous upstream packet kept in case more is needed
var receiveBuffer = []; 	// All client audio packets are held in this 2D buffer
const maxBufferSize = 6;	// Max number of packets to store per client
const mixTriggerLevel = 3;	// When all clients have this many packets we create a mix
var packetSize;			// Number of samples in the client audio packets
const SampleRate = 16000; 	// All audio in audence runs at this sample rate. 
const MaxOutputLevel = 1;	// Max output level for INT16, for auto gain control
var gain = 1;			// The gain applied to the mix 
var upstreamGain = 1;		// Gain applied to the final mix after adding upstream
const MaxGain = 1;		// Don't want to amplify more than x2

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
let d = new Date();			// Set the state at start to Idle
let t = d.getTime();			// and manually set start time
var currentState = idleState;		currentState.start = t;
function enterState( newState ) {
	let d = new Date();
	let now = d.getTime();
	currentState.total += now - currentState.start;
	newState.start = now;
	currentState = newState;
}

// Mix generation is done as fast as data comes in, but should keep up a rythmn
// even if downstream audio isn't sufficient. The time the last mix was sent is here:
var nextMixTimeLimit = 0;

function createClientBuffer(client) {
	let buffer = new ClientBuffer();
	buffer.clientID = client;
	receiveBuffer.push(buffer);
	return buffer;
}

function isTimeToMix() {	// Test if we must generate a mix regardless
	let d = new Date();
	let now = d.getTime();		
	if ((nextMixTimeLimit != 0) && (now >= nextMixTimeLimit)) 
		return true;
	else
		return false;
}

function maxValue( arr ) { 			// Find max value in an array
	let max = arr[0];
	for (let i =  1; i < arr.length; i++)
		if (arr[i] > max) max = arr[i];
	return max;
}

function applyAutoGain(audio, startGain) {		// Auto gain control
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	maxLevel = maxValue(audio);			// Find peak audio level 
	endGain = MaxOutputLevel / maxLevel;		// Desired gain to avoid overload
	if (endGain > MaxGain) endGain = MaxGain;	// Gain is limited to MaxGain
	if (endGain >= startGain) {			// Gain adjustment speed varies
		transitionLength = audio.length;	// Gain increases are gentle
		endGain = startGain + ((endGain - startGain)/10);	// Slow the rate of gain change
	}
	else
		transitionLength = Math.floor(audio.length/10);	// Gain decreases are fast
	tempGain = startGain;				// Start at current gain level
	for (let i = 0; i < transitionLength; i++) {	// Adjust gain over transition
		x = i/transitionLength;
		if (i < (2*transitionLength/3))		// Use the Magic formula
			p = 3*x*x/2;
		else
			p = -3*x*x + 6*x -2;
		tempGain = startGain + (endGain - startGain) * p;
		audio[i] = audio[i] * tempGain;
	}
	if (transitionLength != audio.length) {		// Still audio left to adjust?
		tempGain = endGain;			// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++)
			audio[i] = audio[i] * tempGain;
	}
	return endGain;
}

// Network code
var fs = require('fs');
var express = require('express');
var app = express();
app.use(express.static('public'));

var PORT = process.env.PORT; 
if (PORT == undefined) {		// Not running on heroku so use SSL
	var https = require('https');
	var SSLPORT = 443; //Default 443
	var HTTPPORT = 80; //Default 80 (Only used to redirect to SSL port)
	var privateKeyPath = "./cert/key.pem"; //Default "./cert/key.pem"
	var certificatePath = "./cert/cert.pem"; //Default "./cert/cert.pem"
	var privateKey = fs.readFileSync( privateKeyPath );
	var certificate = fs.readFileSync( certificatePath );
	var server = https.createServer({
    		key: privateKey,
    		cert: certificate
	}, app).listen(SSLPORT);
	// Redirect from http to https
	var http = require('http');
	http.createServer(function (req, res) {
    		res.writeHead(301, { "Location": "https://" + req.headers['host'] + ":"+ SSLPORT + "" + req.url });
    		res.end();
	}).listen(HTTPPORT);
} else {				// On Heroku. No SSL needed
	var http = require('http');
	var server = http.Server(app);
	server.listen(PORT, function() {
		console.log("Server running on ",PORT);
	});
}
var io  = require('socket.io').listen(server, { log: false });





// socket event and audio handling area
io.sockets.on('connection', function (socket) {
	console.log("New connection V1.01:", socket.id);

	socket.on('disconnect', function () {
		console.log("User disconnected:", socket.id);
		console.log("Idle = ", idleState.total, " upstream = ", upstreamState.total, " downstream = ", downstreamState.total, " genMix = ", genMixState.total);
		// No need to remove the client's buffer as it will happen automatically
	});

	socket.on('downstreamHi', function (data) {
		// The upstream server is registering with us
		// There can only be one upstream server
		upstreamServer = socket.id; 
	});
	socket.on('upstreamHi', function (data) {
		// A downstream server or client is registering with us
		// Add the downstream node to the group for notifications
		socket.join('downstream');
	});

	// Audio coming down from our upstream server. It is a mix of all the audio above and beside us
	socket.on('d', function (packet) {
		enterState( upstreamState );
		// If no downstream clients ignore packet and empty upstream buffers
		if (receiveBuffer.length == 0) { upstreamBuffer = []; oldUpstreamBuffer = []; }
		else {
			// TODO: Remove my audio from mix to avoid echo
			upstreamBuffer.push(packet); 
			packetSize = packet.a.length;
			enterState( genMixState );
			generateMix();
		}
		enterState( idleState );
	});

	// Audio coming up from one of our downstream clients
	socket.on('u', function (data) {
		enterState( downstreamState );
		let client = socket.id;
		let packet = data["audio"];
		let b = 0;
		let buffer = null;
		packetSize = packet.length;
		if (receiveBuffer.length == 0) {	// First client, so create buffer right now
			buffer = createClientBuffer(client);
			nextMixTimeLimit = 0;		// Stop sample timer until audio buffered
		} else					// Find this client's buffer
			receiveBuffer.forEach( b => { if ( b.clientID == client ) buffer = b; });
		if (buffer == null)  			// New client but not the first. Create buffer 
			buffer = createClientBuffer(client);
		buffer.packets.push( packet );
		if (buffer.packets.length > maxBufferSize) {
			console.log("BUFFER overflow for  ",client);
			buffer.packets.shift();
		}
		enterState( genMixState );
		generateMix();
		enterState( idleState );
	});
});

function generateMix () {
	let readyToMix = false;
	if (isTimeToMix()) readyToMix = true;
	else {				// It isn't time to mix but is there enough data to mix anyway?
		let b;
		readyToMix = true;	// Assume there IS enough data, but if any buffer is short, no mix
		receiveBuffer.forEach( b => { if (b.packets.length < mixTriggerLevel) readyToMix = false; });
	}
	if (readyToMix) {
		let numberOfClients = receiveBuffer.length;
		let mix = new Array(packetSize).fill(0); // The mixed audio we will return to all clients
		let clientAudio = []; 			// All client audio packets that are part of the mix
		let client = receiveBuffer.length -1;	// We start at the end of the array going backwards
		while (client >=0) { 			// mix all client (downstream) audio together
			let newTrack = { audio: [], clientID: 0 };	// A track is audio + client ID
			let clientBuffer = receiveBuffer[client];	// Shorthand
			newTrack.clientID = clientBuffer.clientID;	// Get clientID for audio
			newTrack.audio = clientBuffer.packets.shift();	// Get first packet of audio
			if (newTrack.audio == undefined) {			// If no audio remove client buffer
				console.log("AUDIO SHORTAGE for client ");
				receiveBuffer.splice(client, 1); 	// Remove client buffer
			}
			else {
				for (let i = 0; i < newTrack.audio.length; ++i) 
					mix[i] = (mix[i] + newTrack.audio[i]);	
				clientAudio.push( newTrack );		// Store piece of source audio 
			}
			client--;			// next client down in buffer
		}
		gain = applyAutoGain(mix, gain); 	// Apply auto gain to mix starting at the current gain level 
		let finalMix = [];			// Final audio mix with upstream audio to send downstream
		if (upstreamServer != null) { 		// We have an upstream server. Send it audio
			if ((upstreamBuffer.length >= mixTriggerLevel) || (oldUpstreamBuffer.length > 0 )) { 
				let upstreamAudio = [];				// Piece of upstream audio to mix in
				if (upstreamBuffer == []) { 			// if no upstream audio
					upstreamAudio = oldUpstreamBuffer;	// Use old buffer
				} else {
					upstreamAudio = upstreamBuffer.shift();	// Get new packet from buffer
					oldUpstreamBuffer = upstreamAudio;	// and store it in old buffer
				}
				for (let i = 0; i < upstreamAudio.length; ++i) 
					finalMix[i] = mix[i] + upstreamAudio[i];
				upstreamGain = applyAutoGain(finalMix, upstreamGain); // Apply auto gain to final mix 
			}
		}
		if (finalMix.length > 0) {	// Send final mix and source audio tracks to all downstream clients
			upstreamServer.volatile.emit("u", mix); // THIS MAY NOT WORK... try io.sockets.socket(upstreamServer).emit
			io.sockets.in('downstream').volatile.emit('d', {
					"a": finalMix,
					"c": clientAudio,
					"g": (gain * upstreamGain) });
		} else { 				// Send mix with no upstream audio to all downstream clients
			io.sockets.in('downstream').volatile.emit('d', {
					"a": mix,
					"c": clientAudio,
					"g": gain });
		}
		// Finally, note when the next mix needs to go out (in mS from now) to avoid glitches
		if (nextMixTimeLimit == 0) {
			let d = new Date();
			let now = d.getTime();		
			nextMixTimeLimit = now;
		}
		nextMixTimeLimit = nextMixTimeLimit + (mix.length * 1000)/SampleRate;
	}
}

// We are all set up so let the idling begin!
enterState( idleState );
console.log("IDLING...");
