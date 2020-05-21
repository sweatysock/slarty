// UI behaviour setup
// 
$(document).ready(function () {
	$("#startBtn").click(function () {
		$(this).hide();
		startTalking();
	});
	$("#muteBtn").click(function () {
		let btn=document.getElementById('muteBtn');
		if (muted == true) {
			muted = false;
			btn.innerText="Mute";
		} else {
			muted = true;
			btn.innerText="Unmute";
		}
	});
	let monitorBtn=document.getElementById('monitorBtn');
	monitorBtn.onclick = function () {
		let monitor=document.getElementById('monitor');
		let monitor2=document.getElementById('monitor2');
		if (monitor.style.visibility == "visible") {
			monitor.style.visibility = "hidden";
			monitor2.style.visibility = "visible";
		} else {
			if (monitor2.style.visibility == "visible")
				monitor2.style.visibility = "hidden";
			else
				monitor.style.visibility = "visible";
		}
	};
	let testBtn=document.getElementById('testBtn');
	testBtn.onclick = function () {
		console.log("Test button pressed");
		if (blockSpkr == true) blockSpkr = false;
		else blockSpkr = true;
		console.log("Tracing = ",blockSpkr);
	};
	let actionBtn=document.getElementById('actionBtn');
	actionBtn.onclick = function () {
		console.log("Action button pressed");
		if (pauseTracing == true) pauseTracing = false;
		else pauseTracing = true;
	};
	setInterval(displayAnimation, 100);
});

var blockSpkr = false;
var pauseTracing = false;

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
var muted = false;			// mic mute control
var mixGain = 1;			// Gain applied to mix
var micGain = 1;			// Gain applied to microphone input

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
var currentState = idleState;		currentState.start = new Date().getTime();
function enterState( newState ) {
	let now = new Date().getTime();
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
const updateTimer = 1000;
var micMax = 0;				// Max mic level to display on level display
var mixMax = 0;				// Max mix level to display...
var tracecount = 0;
function printReport() {
	trace("Idle = ", idleState.total, " data in = ", dataInState.total, " audio in/out = ", audioInOutState.total);
	trace("Sent = ",packetsOut," Heard = ",packetsIn," speaker buffer size ",spkrBuffer.length," mic buffer size ", micBuffer.length," overflows = ",overflows," shortages = ",shortages," micMax = ",micMax," mixMax = ",mixMax);
	let state = "Green";
	trace2("micMax: ",micMax," micGain: ",micGain," mixMax: ",mixMax," mixGain: ",mixGain);
	if ((overflows > 1) || (shortages >1)) state = "Orange";
	if (socketConnected == false) state = "Red";
	setStatusLED("GeneralStatus",state);
	state = "Green";
	if ((packetsOut < 30) || (packetsOut > 35)) state = "Orange";
	if (packetsOut < 5) state = "Red";
	setStatusLED("UpStatus",state);
	state = "Green";
	if ((packetsIn < 30) || (packetsIn > 35)) state = "Orange";
	if (packetsIn < 5) state = "Red";
	setStatusLED("DownStatus",state);
	packetsIn = 0;
	packetsOut = 0;
	overflows = 0;
	shortages = 0;
	timeGap = 0;
	micMax = -2;
	mixMax = -2;
tracecount = 2;
f1();
}

async function  f1() {
const devices = await navigator.mediaDevices.enumerateDevices();
trace(JSON.stringify(devices));
const audioDevices = devices.filter(device => device.kind === 'audiooutput');
const audio = document.createElement('audio');
await audio.setSinkId(audioDevices[0].deviceId);
trace('Audio is being played on ' + audio.sinkId);
}

setInterval(printReport, updateTimer);


// Tracing to the traceDiv (a Div with id="Trace" in the DOM)
//
var traceDiv = null;
var traceDiv2 = null;
var traceArray = [];
var traceArray2 = [];
var maxTraces = 100;
document.addEventListener('DOMContentLoaded', function(event){
	traceDiv = document.getElementById('Trace');
	traceDiv2 = document.getElementById('Trace2');
});
function trace(){	
	if (pauseTracing == false) {
		let s ="";
		for (let i=0; i<arguments.length; i++)
			s += arguments[i];
		console.log(s);
		traceArray.push(s+"<br>");
		if (traceArray.length > maxTraces) traceArray.shift(0,1);
		if (traceDiv != null) {
			traceDiv.innerHTML = traceArray.join("");
			traceDiv.scrollTop = traceDiv.scrollHeight;
		}
	}
}
function trace2(){	
	if (pauseTracing == false) {
		let s ="";
		for (let i=0; i<arguments.length; i++)
			s += arguments[i];
		console.log(s);
		traceArray2.push(s+"<br>");
		if (traceArray2.length > maxTraces) traceArray2.shift(0,1);
		if (traceDiv2 != null) {
			traceDiv2.innerHTML = traceArray2.join("");
			traceDiv2.scrollTop = traceDiv2.scrollHeight;
		}
	}
}


// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {
	trace('socket connected!');
	socketConnected = true;
	socketIO.emit("upstreamHi"); 	// Say hi to the server - we consider it upstream 
});

// Data coming down from upstream server: Group mix plus separate member audios
socketIO.on('d', function (data) { 
	enterState( dataInState );
	packetsIn++;
	let now = new Date().getTime();
	if ((micAccessAllowed) && (blockSpkr == false)) {	// Need access to audio before outputting
		let mix = [];	// Build up a mix of client audio 
		let clients = data.c; 
		for (let c=0; c < clients.length; c++) {
			if (clients[c].clientID != socketIO.id) {
				let a = clients[c].packet.audio;
				if (mix.length == 0)
					for (let i=0; i < a.length; i++)
						mix[i] = a[i];
  				else
	  				for (let i=0; i < a.length; i++)
						mix[i] += a[i];
			}
		}
		let obj = applyAutoGain(mix,mixGain,1);
		if (obj.peak > mixMax) mixMax = obj.peak;
//if ((obj.peak == 0) && (tracecount > 0)) {trace2("Mix 0");tracecount--;clients.forEach(c => {trace2(c.clientID," ",maxValue(c.packet.audio));})}
		mixGain = obj.finalGain;
		if (mix.length != 0) {
			spkrBuffer.push(...mix);
			if (spkrBuffer.length > maxBuffSize) {
				spkrBuffer.splice(0, (spkrBuffer.length-maxBuffSize)); 	
				overflows++;
			}
		}
	}
	enterState( idleState );
});

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
});



// Media management code (audio in and out)
//
function displayAnimation() {
	// called 10 times a second to animate audio displays
	// drop levels a little
	micMax = micMax * 0.9;
	// update displays
	micDisplay(micMax);
}
function micDisplay(level) {
	//if (level > 0) micLED1 = 
}
function setStatusLED(name, level) {
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
}

function maxValue( arr ) { 				// Find max value in an array
	let max = arr[0];
	for (let i =  1; i < arr.length; i++)
		if (arr[i] > max) max = arr[i];
	return max;
}

function applyAutoGain(audio, startGain, maxGain) {	// Auto gain control
	const MaxOutputLevel = 1;			// Max output level permitted
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	maxLevel = maxValue(audio);			// Find peak audio level 
	endGain = MaxOutputLevel / maxLevel;		// Desired gain to avoid overload
	maxLevel = 0;					// Use this to capture peak
	if (endGain > maxGain) endGain = maxGain;	// Gain is limited to maxGain
	if (endGain >= startGain) {			// Gain adjustment speed varies
		transitionLength = audio.length;	// Gain increases are gentle
		endGain = startGain + ((endGain - startGain)/10);	// Slow the rate of gain change
	}
	else
		transitionLength = Math.floor(audio.length/10);	// Gain decreases are fast
	tempGain = startGain;				// Start at current gain level
//	for (let i = 0; i < transitionLength; i++) {	// Adjust gain over transition
//		x = i/transitionLength;
//		if (i < (2*transitionLength/3))		// Use the Magic formula
//			p = 3*x*x/2;
//		else
//			p = -3*x*x + 6*x -2;
//		tempGain = startGain + (endGain - startGain) * p;
//		audio[i] = audio[i] * tempGain;
//		if (audio[i] >= MaxOutputLevel) audio[i] = MaxOutputLevel;
//		else if (audio[i] <= (MaxOutputLevel * -1)) audio[i] = MaxOutputLevel * -1;
//		if (audio[i] > maxLevel) maxLevel = audio[i];
//	}
//	if (transitionLength != audio.length) {		// Still audio left to adjust?
//		tempGain = endGain;			// Apply endGain to rest
//		for (let i = transitionLength; i < audio.length; i++) {
//			audio[i] = audio[i] * tempGain;
//			if (audio[i] >= MaxOutputLevel) audio[i] = MaxOutputLevel;
//			else if (audio[i] <= (MaxOutputLevel * -1)) audio[i] = MaxOutputLevel * -1;
//			if (audio[i] > maxLevel) maxLevel = audio[i];
//		}
//	}
finalGain = 0.117; maxLevel = 0.25;
	return { finalGain: endGain, peak: maxLevel };
}

function hasGetUserMedia() {		// Test for browser capability
	return !!(navigator.getUserMedia || navigator.webkitGetUserMedia ||
		navigator.mozGetUserMedia || navigator.msGetUserMedia);
}

function startTalking() {
	if (hasGetUserMedia()) {
		var context = new window.AudioContext || new window.webkitAudioContext;
		soundcardSampleRate = context.sampleRate;
		let constraints = { mandatory: {
		      			googEchoCancellation: true,
		      			googAutoGainControl: false,
		      			googNoiseSuppression: false,
		      			googHighpassFilter: false
		    		}, optional: [] };
		navigator.getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
		navigator.getUserMedia({ audio: constraints }, function (stream) {
			micAccessAllowed = true;
			var liveSource = context.createMediaStreamSource(stream);
			var node = undefined;
			if (!context.createScriptProcessor) {
				node = context.createJavaScriptNode(chunkSize, 1, 1);
			} else {
				node = context.createScriptProcessor(chunkSize, 1, 1);
			}
			node.onaudioprocess = function (e) {
				enterState( audioInOutState );
				var inData = e.inputBuffer.getChannelData(0);
				var outData = e.outputBuffer.getChannelData(0);
				let micAudio = [];
				if ((socketConnected) && (muted == false)) {		// Mic audio can be sent to server
					micAudio = downSample(inData, soundcardSampleRate, SampleRate);
					resampledChunkSize = micAudio.length;
					micBuffer.push(...micAudio);
					if (micBuffer.length > PacketSize) {
						let outAudio = micBuffer.splice(0, PacketSize);
						let obj = applyAutoGain(outAudio, micGain, 10);
						if (obj.peak > micMax) micMax = obj.peak;
						micGain = obj.finalGain;
						let now = new Date().getTime();
						socketIO.emit("u",
						{
							"audio": outAudio,
							"sequence": packetSequence,
							"timeEmitted": now
						});
						packetsOut++;
						packetSequence++;
					}
				}
				let inAudio = [];
				if (spkrBuffer.length > resampledChunkSize) {	// Server audio can be sent to speaker
					inAudio = spkrBuffer.splice(0,resampledChunkSize);
				} else {
					inAudio = spkrBuffer.splice(0,spkrBuffer.length);
					let zeros = new Array(resampledChunkSize-spkrBuffer.length).fill(0);
					inAudio.push(...zeros);
					shortages++;
				}
				let spkrAudio = upSample(inAudio, SampleRate, soundcardSampleRate);
				for (let i in outData) 
					outData[i] = spkrAudio[i];
				enterState( idleState );
			}

			let lowFreq = 100;					// Bandpass to clean up Mic
			let highFreq = 4000;
			let geometricMean = Math.sqrt(lowFreq * highFreq);
			var micFilter = context.createBiquadFilter();
			micFilter.type = 'bandpass';
			micFilter.frequency.value = geometricMean;
			micFilter.Q.value = geometricMean / (highFreq - lowFreq);
			
			var splitter = context.createChannelSplitter(2);	// Split signal for echo cancelling

			var echoDelay = context.createDelay(5);			// Delay to match speaker echo
			echoDelay.delayTime.value = 0.00079

			lowFreq = 300;						// Echo filter to match speaker+mic
			highFreq = 5000;
			geometricMean = Math.sqrt(lowFreq * highFreq);
			var echoFilter = context.createBiquadFilter();
			echoFilter.type = 'bandpass';
			echoFilter.frequency.value = geometricMean;
			echoFilter.Q.value = geometricMean / (highFreq - lowFreq);
			
			var gainNode = context.createGain();			// Cancelling requires inverting signal
			gainNode.gain.value = -1;

			liveSource.connect(micFilter);				// Mic goes to micFilter
			micFilter.connect(node);				// micFilter goes to our processor
			node.connect(splitter);					// our processor feeds to a splitter
			splitter.connect(echoDelay,0);				// one output goes to feedback loop
			splitter.connect(context.destination,0);		// other output goes to speaker
			echoDelay.connect(echoFilter);				// feedback echo goes to echo filter
			echoFilter.connect(gainNode);				// echo filter goes to inverter
			gainNode.connect(micFilter);				// inverter feeds back into micFilter
			gainNode.gain.value = 0;				// Start with feedback loop off
		}, function (err) { trace(err); });
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
	let resampledBufferLength = chunkSize;		// Forcing to always fill the outbuffer fully
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

enterState( idleState );
trace("Starting V3.0");
