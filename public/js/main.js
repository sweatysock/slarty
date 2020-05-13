// UI behaviour setup
// 
$(document).ready(function () {
	$("#startBtn").click(function () {
		$(this).hide();
		startTalking();
	});
});


//Global variables
//
const SampleRate = 16000; 		// Global sample rate used for all audio
const PacketSize = 500;			// Server packet size we must conform to
var chunkSize = 1024;			// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 	// Get this from context 
var resampledChunkSize = 0;		// Once resampled the chunks are this size
var socketConnected = false; 		// True when socket is up
var micAccessAllowed = false; 		// Need to get user permission
var spkrBuffer = []; 			// Audio buffer going to speaker
var maxBuffSize = 5000;			// Max audio buffer chunks for playback
var micBuffer = [];			// Buffer mic audio before sending

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
var dataInState = new stateTimer();	dataInState.name = "Data In";
var audioInOutState = new stateTimer();	audioInOutState.name = "Audio In/Out";
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

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var overflows = 0;
var shortages = 0;
var packetSequence = 0;			// Tracing packet ordering
var currentSeq = 0;			// Last packet sequence received
var seqGap = 0;				// Accumulators for round trip measurements
var timeGap = 0;
var seqStep = 0;
const updateTimer = 10000;
function printReport() {
	console.log("Idle = ", idleState.total, " data in = ", dataInState.total, " audio in/out = ", audioInOutState.total);
	console.log("Sent = ",packetsOut," Heard = ",packetsIn," speaker buffer size ",spkrBuffer.length," mic buffer size ", micBuffer.length," overflows = ",overflows," shortages = ",shortages);
	packetsIn = 0;
	packetsOut = 0;
	overflows = 0;
	shortages = 0;
	timeGap = 0;
}
setInterval(printReport, updateTimer);



// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {
	console.log('socket connected!');
	socketConnected = true;
	socketIO.emit("upstreamHi"); 	// Say hi to the server - we consider it upstream 

	// Data coming down from upstream server: Group mix plus separate member audios
	socketIO.on('d', function (data) { 
		enterState( dataInState );
		packetsIn++;
		let d = new Date();
		let now = d.getTime();
		if (micAccessAllowed) {	// Need access to audio before outputing
			let mix = [];	// Build up a mix of client audio 
			let clients = data.c; 
			for (let c=0; c < clients.length; c++) {
				if (clients[c].clientID != socketIO.id) {
					let a = clients[c].packet.audio;
					timeGap += now - clients[c].packet.timeEmitted;
					if (mix.length == 0)
						for (let i=0; i < a.length; i++)
							mix[i] = a[i];
	  				else
		  				for (let i=0; i < a.length; i++)
							mix[i] += a[i];
				}
			}
			if (mix.length != 0) {
				for (let i in mix) spkrBuffer.push(mix[i]);
				if (spkrBuffer.length > maxBuffSize) {
					spkrBuffer.splice(0, (spkrBuffer.length-maxBuffSize)); 	
					overflows++;
				}
			}
		}
		enterState( idleState );
	});
});

socketIO.on('disconnect', function () {
	console.log('socket disconnected!');
	socketConnected = false;
});



// Need function to receive UI position updates in order to rebuild audio mix table
// and to send the new UI position out to the other clients


// Media management code (audio in and out)
//
function hasGetUserMedia() {		// Test for browser capability
	return !!(navigator.getUserMedia || navigator.webkitGetUserMedia ||
		navigator.mozGetUserMedia || navigator.msGetUserMedia);
}

function startTalking() {
	if (hasGetUserMedia()) {
		var context = new window.AudioContext || new window.webkitAudioContext;
		soundcardSampleRate = context.sampleRate;
		let constraints = { mandatory: {
		      			googEchoCancellation: false,
		      			googAutoGainControl: false,
		      			googNoiseSuppression: false,
		      			googHighpassFilter: false
		    		}, optional: [] };
		navigator.getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
		navigator.getUserMedia({ audio: constraints }, function (stream) {
			micAccessAllowed = true;
			var liveSource = context.createMediaStreamSource(stream);
			if (!context.createScriptProcessor) {
				node = context.createJavaScriptNode(chunkSize, 1, 1);
			} else {
				node = context.createScriptProcessor(chunkSize, 1, 1);
			}
			node.onaudioprocess = function (e) {
				enterState( audioInOutState );
				var inData = e.inputBuffer.getChannelData(0);
				var outData = e.outputBuffer.getChannelData(0);
				let audio = [];
				if (socketConnected) {		// Mic audio can be sent to server
					audio = downSample(inData, soundcardSampleRate, SampleRate);
					resampledChunkSize = audio.length;
					for (let i in audio) micBuffer.push(audio[i]);
					if (micBuffer.length > PacketSize) {
						audio = micBuffer.splice(0, PacketSize);
						let d = new Date();
						let now = d.getTime();
						socketIO.emit("u",
						{
							"audio": audio,
							"sequence": packetSequence,
							"timeEmitted": now
						});
						packetsOut++;
						packetSequence++;
					}
				}
				if (spkrBuffer.length > resampledChunkSize) 
					audio = spkrBuffer.splice(0,resampledChunkSize);
				else {	
					audio.fill(0,0,(resampledChunkSize-1));
					shortages++;
				}
				audio = upSample(audio, SampleRate, soundcardSampleRate);
				for (let i in audio) 
					outData[i] = audio[i];
				enterState( idleState );
			}
			liveSource.connect(node);
			node.connect(context.destination);
		}, function (err) { console.log(err); });
	} else {
		alert('getUserMedia() is not supported in your browser');
	}
}

// Resamplers
//
var  downCache = [0.0,0.0];
function downSample( buffer, originalSampleRate, resampledRate) {
	let resampledBufferLength = Math.round( buffer.length * resampledRate / originalSampleRate );
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( let i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = upCache[ 1 + tap ];
				if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	downCache[ 0 ] = buffer[ buffer.length - 2 ];
	downCache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
	return outputData;
}

var  upCache = [0.0,0.0];
function upSample( buffer, originalSampleRate, resampledRate) {
	let resampledBufferLength = Math.round( buffer.length * resampledRate / originalSampleRate );
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( var i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = upCache[ 1 + tap ];
				if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	upCache[ 0 ] = buffer[ buffer.length - 2 ];
	upCache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
	return outputData;
}

// From http://johncostella.webs.com/magic/
function magicKernel( x ) {
  if ( x < -0.5 ) {
    return 0.5 * ( x + 1.5 ) * ( x + 1.5 );
  }
  else if ( x > 0.5 ) {
    return 0.5 * ( x - 1.5 ) * ( x - 1.5 );
  }
  return 0.75 - ( x * x );
}

