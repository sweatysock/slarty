//Global variables
//
const SampleRate = 16000; 						// Global sample rate used for all audio
const PacketSize = 500;							// Server packet size we must conform to
var chunkSize = 1024;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var resampledChunkSize = 0;						// Once resampled the chunks are this size
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var spkrBuffer = []; 							// Audio buffer going to speaker
var maxBuffSize = 5000;							// Max audio buffer chunks for playback
var micBuffer = [];							// Buffer mic audio before sending
var myChannel = -1;							// The server assigns us an audio channel
var myName = "";							// Name assigned to my audio channel
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		name	: "",						// Each client names their channel
		gain 	: 1,						// Manual gain level. Start at zero and fade up
		agc	: true,						// Flag if control is manual or auto
		muted	: false,					// Local mute
		peak	: 0,						// Animated peak channel audio level 
		channel	: i,						// The channel needs to know it's number for UI referencing
	};
}
var mixOut = {								// Similar structures for the mix output
	name 	: "Output",
	gain	: 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "mixOut",
};
var micIn = {								// and for microphone input
	name 	: "Mic",
	gain	: 0,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "micIn",
	threshold:0.01,							// Level below which we don't send audio
};





// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {				// New connection coming in
	trace('socket connected!');
	socketIO.emit("upstreamHi",{channel:myChannel}); 		// Register with server and request channel
});

socketIO.on('channel', function (data) {				// Message assigning us a channel
	if (data.channel > 0) {						// Assignment successful
		myChannel = data.channel;
		if (myName == "") myName = "Channel " + myChannel;
		trace('Channel assigned: ',myChannel);
		socketConnected = true;					// The socket can be used once we have a channel
	} else {
		trace("Server unable to assign a channel");		// Server is probaby full
		trace("Try a different server");			// Can't do anything more
		socketConnected = false;
	}
});

// Data coming down from upstream server: Group mix plus separate member audios
socketIO.on('d', function (data) { 
	enterState( dataInState );					// This is one of our key tasks
	packetsIn++;							// For monitoring and statistics
	if ((micAccessAllowed) && (blockSpkr == false)) {		// Need access to audio before outputting
		let mix = [];						// Build up a mix of client audio 
		data.channels.forEach(c => {
			if (c.socketID != socketIO.id) {		// Don't include my audio in mix
				let ch = c.channel;
				channels[ch].name = c.name;		// Update the channel name
				channels[ch].channel = ch;		// Update the channel number
				if (!channels[ch].muted) {		// We can skip a muted channel
					let a = c.audio;
					let g = channels[ch].gain;	// apply manual gain, if different from 1
					if (channels[ch].peak < c.peak)	// set the peak for level display
						channels[ch].peak = c.peak;
					if (mix.length == 0)		// First audio in mix goes straight
						for (let i=0; i < a.length; i++)
							mix[i] = a[i] * g;
  					else
	  					for (let i=0; i < a.length; i++)
							mix[i] += a[i] * g;
				}
			} else {					// This is my own data come back
				let now = new Date().getTime();
				rtt = now - c.timestamp;		// Measure round trip time
			}
		});
		let obj = applyAutoGain(mix,mixOut.gain,1);		// Correct mix level with AGC 
		mixOut.gain= obj.finalGain;				// Store gain for next loop
		if (obj.peak > mixOut.peak) mixOut.peak = obj.peak;	// Note peak for display purposes
		if (mix.length != 0) {					// If there actually was some audio
			spkrBuffer.push(...mix);			// put it on the speaker buffer
			if (spkrBuffer.length > maxBuffSize) {		// Clip buffer if too full
				spkrBuffer.splice(0, (spkrBuffer.length-maxBuffSize)); 	
				overflows++;				// Note for monitoring purposes
			}
		}
	}
	enterState( idleState );					// Back to Idling
});

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
});







// Media management and display code (audio in and out)
//
document.addEventListener('DOMContentLoaded', function(event){
	setInterval(displayAnimation, 100);				// Call animated display 10 x a second
});

const NumLEDs = 21;							// Number of LEDs in the level displays
function displayAnimation() { 						// called 100mS to animate audio displays
	const rate = 0.7;						// Speed of peak drop in LED level display
	if (micAccessAllowed) {						// Once we have audio we can animate audio UI
		mixOut.peak = mixOut.peak * rate; 			// drop mix peak level a little for smooth drops
		setLevelDisplay( mixOut );				// Update LED display for mix.peak
		setSliderPos( mixOut );					// Update slider position for mix gain
		micIn.peak = micIn.peak * rate; 			// drop mic peak level a little for smooth drops
		setLevelDisplay( micIn );				// Update LED display for mic.peak
		setSliderPos( micIn );					// Update slider position for mic gain
		channels.forEach(c => {					// Update each channel's UI
			if (c.name != "") {				// A channel needs a name to be active
				if (c.displayID == undefined)		// If there is no display associated to the channel
					createChannelUI(c);		// build the visuals 
				c.peak = c.peak * rate;			// drop smoothly the max level for the channel
				setLevelDisplay( c );			// update LED display for channel peak
				setSliderPos( c );			// update slider position for channel gain
			}
		});
	}
}

function setLevelDisplay( obj ) { 					// Set LED display level for obj
	let v = obj.peak;
	let h1, h2, h3;
	if (v < 0.010) {h1 = 0; h2 = 0; h3 = 0;} else					// v indicates how many LEDs to make visible
	if (v < 0.012) {h1 = 3.1; h2 = 0; h3 = 0;} else					// Obviously the higher v the more LEDs on
	if (v < 0.016) {h1 = 6.2; h2 = 0; h3 = 0;} else					// These emulate the function:
	if (v < 0.019) {h1 = 9.3; h2 = 0; h3 = 0;} else					// v = 10.5 * Math.log10( v ) + 21
	if (v < 0.024) {h1 = 12.4; h2 = 0; h3 = 0;} else
	if (v < 0.030) {h1 = 15.5; h2 = 0; h3 = 0;} else
	if (v < 0.037) {h1 = 18.6; h2 = 0; h3 = 0;} else
	if (v < 0.046) {h1 = 21.7; h2 = 0; h3 = 0;} else
	if (v < 0.058) {h1 = 24.8; h2 = 0; h3 = 0;} else
	if (v < 0.072) {h1 = 27.9; h2 = 0; h3 = 0;} else
	if (v < 0.09) {h1 = 31; h2 = 0; h3 = 0;} else
	if (v < 0.11) {h1 = 34; h2 = 0; h3 = 0;} else
	if (v < 0.13) {h1 = 37.1; h2 = 0; h3 = 0;} else
	if (v < 0.17) {h1 = 40.2; h2 = 0; h3 = 0;} else
	if (v < 0.21) {h1 = 43.3; h2 = 0; h3 = 0;} else
	if (v < 0.26) {h1 = 46.4; h2 = 0; h3 = 0;} else
	if (v < 0.33) {h1 = 49.5; h2 = 0; h3 = 0;} else
	if (v < 0.41) {h1 = 49.5; h2 = 3.1; h3 = 0;} else
	if (v < 0.51) {h1 = 49.5; h2 = 6.2; h3 = 0;} else
	if (v < 0.64) {h1 = 49.5; h2 = 9.3; h3 = 0;} else
	if (v < 0.8) {h1 = 49.5; h2 = 9.3; h3 = 3.1;} else 
		{h1 = 49.5; h2 = 9.3; h3 = 6.2;}
	let d = document.getElementById(obj.displayID+"LevelGreen");
	d.style.height = h1+"%";
	d = document.getElementById(obj.displayID+"LevelOrange");
	d.style.height = h2+"%";
	d = document.getElementById(obj.displayID+"LevelRed");
	d.style.height = h3+"%";
}

function setSliderPos( obj ) {
	if (obj.gain < 1) pos = (34 * obj.gain) + 8; 
	else
		pos = (2.5 * obj.gain) + 39.5;
	let sl = document.getElementById(obj.displayID + "Slider");
	sl.style.bottom = pos + "%" ;
}

function createChannelUI(obj) {
	let name = "ID"+obj.channel;
	// build UI elements for a single channel with element IDs that include the name requested
	// non LED: <div style="position:absolute;bottom:8%; right:5%; width:40%; height:65%; background-color:#999999" id="'+name+'SlideBox></div> \
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:40%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<img style="position:absolute;right:20%; top:10%;width:50%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:20%; top:10%;width:50%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.channel+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function convertIdToObj(id) {						// Translate HTML DOM IDs to JS data objects
	id = id.substring(2);
	if (parseFloat(id)) id = parseFloat(id);
	if (typeof(id) == "number") {
		id = channels[id];					// ID is channel number so get the channel object
	} else {
		id = eval(id);						// Convert the ID to the object (micIn or mixOut)
	}
	return id;
}

function muteButton(e) {
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	id.muted = true;
}

function unmuteButton(e) {
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "visible";
	id = convertIdToObj(id);
	id.muted = false;
}

var dragging=false;							// Flag if slider dragging is happening
var dragStartY;								// Y coord where dragging started
var dragStartPct;							// start % from bottom for dragged slider
function sliderDragStart(event) {
	dragging = true;
	event.target.style.cursor='pointer';				// Make pointer look right
	dragStartY = event.clientY;					// Store where the dragging started
	if (isNaN(dragStartY)) dragStartY = event.touches[0].clientY;	// If it is NaN must be a touchscreen
	let id = event.target.parentNode.id;
	let slider = document.getElementById(id+"Slider");
	dragStartPct = parseFloat(slider.style.bottom);			// Get the slider's current % position
}

function sliderDrag(event) {
	if (dragging) {
		let y = event.clientY;					// Get current cursor Y coord
		if (isNaN(y)) y = event.touches[0].clientY;		// If it is NaN we must be on a touchscreen
		y = (dragStartY - y);					// Get the cursor positon change
		let pct = (y/event.target.clientHeight*0.65)*100;	// Calculate the change as a % of the range (0.65 is a fudge... coords are wrong but life is short)
		p = dragStartPct + pct;					// Apply the change to the initial position
		let id = event.target.parentNode.id;
		let slider = document.getElementById(id+"Slider");
		slider.style.bottom = p;				// Move the slider to the desired position
		if (p < 8) p = 8;					// Limit slider movement
		if (p > 65) p = 65;
		let gain;						// Now calculate the gain this position implies
		if (p < 42) 						// Inverse equations used for slider positioning
			gain = (p -8)/34;
		else
			gain = (p - 39.5)/2.5;
		id = convertIdToObj(id);				// Get the js object ID for this UI element
		id.gain = gain;						// Set the object's gain level 
	}
}

function sliderDragStop(event) {
	event.target.style.cursor='default';
	dragging = false;
}

function setStatusLED(name, level) {					// Set the status LED's colour
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
}

function maxValue( arr ) { 						// Find max value in an array
	let max = 0;	
	let v;
	for (let i =  0; i < arr.length; i++) {
		v = Math.abs(arr[i]);					// max ABSOLUTE value
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

function processAudio(e) {						// Main processing loop
	// There are two activities here: 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker
	
	enterState( audioInOutState );					// Log time spent here
	var inData = e.inputBuffer.getChannelData(0);			// Audio from the mic
	var outData = e.outputBuffer.getChannelData(0);			// Audio going to speaker
	let micAudio = [];						// 1. Mic audio processing...
	if ((socketConnected) && (micIn.muted == false)) {		// Need connection to send
		micAudio = downSample(inData, soundcardSampleRate, SampleRate);
		resampledChunkSize = micAudio.length;			// Note how much audio is needed
		micBuffer.push(...micAudio);				// Buffer mic audio until enough
		if (micBuffer.length > PacketSize) {			// Got enough
			let outAudio = micBuffer.splice(0, PacketSize);	// Get a packet of audio
			let floor = maxValue(outAudio);			// Get peak level for this packet
trace2("floor: ",floor);
			if (floor > micIn.threshold) {			// if audio level is above threshold send it
trace2("good enough");
				let obj = applyAutoGain(outAudio, micIn.gain, 5);	// Bring the mic up to level, but 5x is max
				if (obj.peak > micIn.peak) micIn.peak = obj.peak;	// Note peak for local display
				micIn.gain = obj.finalGain;			// Store gain for next loop
				let now = new Date().getTime();
				socketIO.emit("u",
				{
					"name"		: myName,		// Send the name we have chosen 
					"audio"		: outAudio,		// Resampled, level-corrected audio
					"sequence"	: packetSequence,	// Usefull for detecting data losses
					"timestamp"	: now,			// Used to measure round trip time
					"peak" 		: obj.peak,		// Saves having to calculate again
					"channel"	: myChannel,		// Send assigned channel to help server
				});
				packetsOut++;					// For stats and monitoring
				packetSequence++;
			}
		}
	}

	let inAudio = [];						// 2. Output audio to speaker
	if (spkrBuffer.length > resampledChunkSize) {			// There is enough audio buffered
		inAudio = spkrBuffer.splice(0,resampledChunkSize);	// Get same amount of audio as came in
	} else {							// Not enough audio.
		inAudio = spkrBuffer.splice(0,spkrBuffer.length);	// Take all that remains and complete with 0s
		let zeros = new Array(resampledChunkSize-spkrBuffer.length).fill(0);
		inAudio.push(...zeros);
		shortages++;						// For stats and monitoring
	}
	let spkrAudio = upSample(inAudio, SampleRate, soundcardSampleRate); // Bring back to HW sampling rate
	for (let i in outData) 
		outData[i] = spkrAudio[i];				// Copy audio to output
	enterState( idleState );					// We are done. Back to Idling
}

function handleAudio(stream) {						// We have obtained media access
	let context = new window.AudioContext || new window.webkitAudioContext;
	soundcardSampleRate = context.sampleRate;
	micAccessAllowed = true;
	createChannelUI( mixOut );					// Create the output mix channel UI
	createChannelUI( micIn );					// Create the microphone channel UI
	let liveSource = context.createMediaStreamSource(stream); 	// Create audio source (mic)
	let node = undefined;
	if (!context.createScriptProcessor) {				// Audio processor node
		node = context.createJavaScriptNode(chunkSize, 1, 1);	// The new way is to use a worklet
	} else {							// but the results are not as good
		node = context.createScriptProcessor(chunkSize, 1, 1);	// and it doesn't work everywhere
	}
	node.onaudioprocess = processAudio;				// Link the callback to the node

	let lowFreq = 100;						// Bandpass to clean up Mic
	let highFreq = 4000;
	let geometricMean = Math.sqrt(lowFreq * highFreq);
	let micFilter = context.createBiquadFilter();
	micFilter.type = 'bandpass';
	micFilter.frequency.value = geometricMean;
	micFilter.Q.value = geometricMean / (highFreq - lowFreq);
	
	let splitter = context.createChannelSplitter(2);		// Split signal for echo cancelling

	let echoDelay = context.createDelay(5);				// Delay to match speaker echo
	echoDelay.delayTime.value = 0.00079

	lowFreq = 300;							// Echo filter to match speaker+mic
	highFreq = 5000;
	geometricMean = Math.sqrt(lowFreq * highFreq);
	let echoFilter = context.createBiquadFilter();
	echoFilter.type = 'bandpass';
	echoFilter.frequency.value = geometricMean;
	echoFilter.Q.value = geometricMean / (highFreq - lowFreq);
	
	let gainNode = context.createGain();				// Cancelling requires inverting signal
	gainNode.gain.value = -1;
									// Time to connect everything...
	liveSource.connect(micFilter);					// Mic goes to micFilter
	micFilter.connect(node);					// micFilter goes to audio processor
	node.connect(splitter);						// our processor feeds to a splitter
	splitter.connect(echoDelay,0);					// one output goes to feedback loop
	splitter.connect(context.destination,0);			// other output goes to speaker
	echoDelay.connect(echoFilter);					// feedback echo goes to echo filter
	echoFilter.connect(gainNode);					// echo filter goes to inverter
	gainNode.connect(micFilter);					// inverter feeds back into micFilter
	gainNode.gain.value = 0;					// Start with feedback loop off
}

document.addEventListener('DOMContentLoaded', function(event){
	initAudio();							// Call initAudio() once loaded
});

function initAudio() {							// Set up all audio handling here
	let constraints = { 						// Try to get the right audio setup
		mandatory: {						// There don't really work though
 			googEchoCancellation: true,
			googAutoGainControl: false,
			googNoiseSuppression: false,
			googHighpassFilter: false 
		}, 
		optional: [] 
	};
	navigator.getUM = (navigator.getUserMedia || navigator.webKitGetUserMedia || navigator.moxGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
	if (navigator.mediaDevices.getUserMedia) {			// The new way to request media
		trace("Using GUM with promise");			// is using .mediaDevices and promises
		navigator.mediaDevices.getUserMedia({  audio: constraints }) .then(function (stream) {
			handleAudio(stream);
		})
		.catch(function (e) { trace(e.name + ": " + e.message); });
	} else {							// Not everyone supports this though
		trace("Using OLD GUM");					// So use the old one if necessary
		navigator.getUM({ audio: constraints }, function (stream) {
			handleAudio(stream);
		}, function () { trace("Audio HW is not accessible."); });
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
	let resampledBufferLength = chunkSize;				// Forcing to always fill the outbuffer fully
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
function magicKernel( x ) {						// This thing is crazy cool
  if ( x < -0.5 ) {							// three curves that map x to y
    return 0.5 * ( x + 1.5 ) * ( x + 1.5 );				// in a harmonic-free manner
  }									// so that up and down sampling 
  else if ( x > 0.5 ) {							// is as clean as possible.
    return 0.5 * ( x - 1.5 ) * ( x - 1.5 );				// All this in 5 lines of code!
  }
  return 0.75 - ( x * x );
}













// Tracing, monitoring, reporting and debugging code
// 
document.addEventListener('DOMContentLoaded', function(event){
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
	// Buttons used for testing...
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
});
var blockSpkr = false;
var pauseTracing = false;

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var overflows = 0;
var shortages = 0;
var packetSequence = 0;							// Tracing packet ordering
var rtt = 0;
var tracecount = 0;
function printReport() {
	trace("Idle = ", idleState.total, " data in = ", dataInState.total, " audio in/out = ", audioInOutState.total);
	trace("Sent = ",packetsOut," Heard = ",packetsIn," speaker buffer size ",spkrBuffer.length," mic buffer size ", micBuffer.length," overflows = ",overflows," shortages = ",shortages," RTT = ",rtt);
	let state = "Green";
	trace("micIn.peak: ",micIn.peak," micIn.gain: ",micIn.gain," mixOut.peak: ",mixOut.peak," mixOut.gain: ",mixOut.gain);
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
	rtt = 0;
	tracecount = 2;
}

setInterval(printReport, 1000);						// Call report generator once a second


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




enterState( idleState );
trace("Starting V3.1");
