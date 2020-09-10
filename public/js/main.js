//Global variables
//
const SampleRate = 16000; 						// Global sample rate used for all audio
const PacketSize = 500;							// Server packet size we must conform to
const HighFilterFreq = SampleRate/2.2;					// Mic filter to remove high frequencies before resampling
const LowFilterFreq = 200;						// Mic filter to remove low frequencies before resampling
const PerfSampleRate = 32000; 						// Target sample rate used for performer audio adjusted for BW
const ChunkSize = 1024;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var micAudioPacketSize = 0;						// Calculate this once we have soundcard sample rate
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var packetBuf = [];							// Buffer of packets sent, subtracted from venue mix later
var spkrBufferL = []; 							// Audio buffer going to speaker (left)
var spkrBufferR = []; 							// (right)
var venueBuffer = []; 							// Buffer for venue audio
var maxBuffSize = 20000;						// Max audio buffer chunks for playback. 
var micBufferL = [];							// Buffer mic audio before sending
var micBufferR = [];							
var myChannel = -1;							// The server assigns us an audio channel
var myName = "";							// Name assigned to my audio channel
var myGroup = "noGroup";						// Group user belongs to. Default is no group.
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		name	: "",						// Each client names their channel
		gain 	: 1,						// Gain level for the channel
		agc	: true,						// Flag if control is manual or auto
		muted	: false,					// Local mute
		peak	: 0,						// Animated peak channel audio level 
		channel	: i,						// The channel needs to know it's number for UI referencing
		seq	:0,						// Track channel sequence numbers to monitor quality
	};
}
var liveShow = false;							// If there is a live show underway 
var serverLiveChannels = [];						// Server will keep us updated on its live channels here
var mixOut = {								// Similar structures for the mix output
	name 	: "Output",
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "mixOut",
};
var micIn = {								// and for microphone input
	name 	: "Mic",
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "micIn",
	threshold:0.000,						// Level below which we don't send audio
	gate	: 1,							// Threshold gate. >0 means open.
};
var recording = false;							// Used for testing purposes
var serverMuted = false;
var venueSize = 1;							// Number of people in the venue. Used for adjusting venue audio.
var venueSizeCmd = 0;							// Size of venue sent through command channel from event manager
var audience = 1;							// Number of clients in this venue as reported to us by server
var rtt = 0;								// Round Trip Time used to adjust sample rate to avoid logjamming
var rtt1 = 0;								// 1 second average rtt
var rtt5 = 0;								// 5 second average rtt. These need to be similar for stability

function processCommands(newCommands) {					// Apply commands sent from upstream servers
	if (newCommands.mute != undefined) serverMuted = newCommands.mute; else serverMuted = false;
	if (newCommands.gateDelay != undefined) gateDelay = newCommands.gateDelay;
	if (newCommands.venueSize != undefined) venueSizeCmd = newCommands.venueSize;
	if (newCommands.perfLevel != undefined) if (performer) {micIn.gain = newCommands.perfLevel; micIn.agc = false;}
	if (newCommands.noiseThreshold != undefined) noiseThreshold = newCommands.noiseThreshold;
	if (newCommands.displayURL != undefined);
	if (newCommands.displayText != undefined);
}

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
		if (myName == "") myName = "Input " + myChannel;	// Name my channel if empty
		micIn.name = "Mic ("+ myChannel +")";			// Indicate channel in Mic name
		let id = document.getElementById("ID"+micIn.channel+"Name")
		if (id != null) id.innerHTML = micIn.name;		// Update onscreen name if created
		trace('Channel assigned: ',myChannel);
		socketConnected = true;					// The socket can be used once we have a channel
	} else {
		trace("Server unable to assign a channel");		// Server is probaby full
		trace("Try a different server");			// Can't do anything more
		socketConnected = false;
	}
});

var performer = false;							// Indicates if we are the performer
socketIO.on('perf', function (data) {					// Performer status notification
	performer = data.live;
	if (performer == true) {
		document.getElementById("onair").style.visibility = "visible";
		micFilter1.frequency.value = PerfSampleRate/2.2;	// Change mic filter for performance audio
		micFilter2.frequency.value = 30;
	} else {
		document.getElementById("onair").style.visibility = "hidden";
		micFilter1.frequency.value = HighFilterFreq		// Return mic filter to normal settings
		micFilter2.frequency.value = LowFilterFreq;
	}
});

// Data coming down from upstream server: Group mix plus separate member audios
socketIO.on('d', function (data) { 
	enterState( dataInState );					// This is one of our key tasks
	packetsIn++;							// For monitoring and statistics
	let len=JSON.stringify(data).length/1024;			// Get actual packet size received before any changes
	bytesRcvd += len;						// Accumulate in incoming data total count
	serverLiveChannels = data.liveChannels;				// Server live channels are for UI updating
	processCommands(data.commands);					// Process commands from server
	if (micAccessAllowed) {						// Need access to audio before outputting
		let v = [];						// Our objective is to get the venue audio (if any) in here,
		let gL = [], gR = [];					// the group stereo audio (if any) in here
		let pL = [], pR = [];					// and the performer stereo audio (if any) in here. Then mix and send to speaker
		// 1. Process Channel 0 venue mix from server 
		let c0;							
		let ts = 0;
		data.channels.forEach(c => {if (c.channel==0) c0=c});	// Find the venue channel, channel 0
		if (c0 != null) {					// If there is c0 data find our seq #, subtract it, & correct venue level
			channels[0].name = c0.name;			// TEMP FIX
			channels[0].channel = 0;			// TEMP FIX
			channels[0].gain = (channels[0].agc ? mixOut.gain : channels[0].gain);		// TEMP FIX
			ts = c0.timestamps[myChannel];			// Channel 0 also contains timestamps that allow rtt measurement
			audience = c0.liveClients;			// The server sends us the current audience count for level setting
			if (venueSizeCmd == 0) venueSize = audience;	// If there is no command setting the venue size we use the audience size
			else venueSize = venueSizeCmd;			// otherwise the command sets the audience size = attenuation level
			let a8 = [], a16 = [];				// Temp store for our audio for subtracting (echo cancelling)
			let s = c0.seqNos[myChannel];			// If Channel 0's mix contains our audio this will be its sequence no.
			if (s != null) {				// If we are performer or there are network issues our audio won't be in the mix
				while (packetBuf.length) {		// Scan the packet buffer for the packet with this sequence
					let p = packetBuf.shift();	// Remove the oldest packet from the buffer until s is found
					if (p.sequence == s) {		// We have found the right sequence number
						a8 = p.audio.mono8;	// Get our MSRE blocks from packet buffer
						a16 = p.audio.mono16;	
						break;			// Packet found so stop scanning the packet buffer. 
					}
				}
			}
			let v8 = c0.audio.mono8, v16 = c0.audio.mono16;	// Shortcuts to the channel 0 MSRE data blocks
			if (v8.length > 0) {				// If there is venue audio it will need processing
				let sr = 8000;				// Minimum sample rate of 8kHz
				if (a8.length > 0)  			// Only subtract if our audio is not empty
					for (let i = 0; i < a8.length; ++i) v8[i] = (v8[i] - a8[i]) * channels[0].gain / venueSize;
				if ((v16.length > 0) && 		// Does venue and our audio have higher quality audio?
					(a16.length > 0)) { 	// If so subtract our high bandwidth audio from venue
					for (let i = 0; i < a16.length; ++i) v16[i] = (v16[i] - a16[i]) * channels[0].gain / venueSize;
				} 					// By this stage our audio has been subtracted from venue audio
				if (v16.length > 0) {			// If the venue has higher quality audio
					let k = 0;			// reconstruct the original venue audio in v[]
					for (let i=0;i<v8.length;i++) {	
						v[k] = v8[i] + v16[i];k++;
						v[k] = v8[i] - v16[i];k++;
					}
					sr = 16000;			// This is at the higher sample rate
				} else v = v8;				// Only low bandwidth venue audio 
				let p = maxValue(v);			// Get peak audio for channel 0 level display 
				if (p > channels[0].peak) channels[0].peak = p;
				v = reSample(v, sr, soundcardSampleRate, vCache); 
			} else c0.peak = 0;				// Don't need to be a genius to figure that one out if there's no audio!
		} 
		// 2. Build a mix of all group channels. For individuals or empty groups no audio will have been sent
		let t8 = new Array(PacketSize/2).fill(0);		// Temp arrays for MSRE blocks 
		let t16 = new Array(PacketSize/2).fill(0);		// so that we only do one MSRE decode at the end
		let someAudio = false;					// If no audio this saves us checking
		// Group spacial positioning design:
		// Get number of channels excluding venue
		// Need to assign a location to a channel so need to know what channels there are first
		// With each channel at start if no delay cache in channel create it and put N samples in it
		// Put delay cache into L or R as appropriate
		// Then for each live sample...
		// Process audio adding samples to each channel using two pointers
		// Stop feeding delayed audio to delayed channel at end and feed instead to delay cache
		data.channels.forEach(c => {				// Process all audio channel packets including channel 0
			let ch = c.channel;				// Channel number the packet belongs to
			let chan = channels[ch];			// Local data structure for this channel
			if ((c.socketID != socketIO.id) && (ch != 0)) {	// Don't include my audio or channel 0 in the group mix
				chan.name = c.name;			// Update local structure's channel name
				chan.channel = ch;			// Keep channel number too. It helps speed lookups
				if (chan.peak < c.peak)			// set the peak for this channel's level display
					chan.peak = c.peak;		// even if muted
				let a = c.audio;			// Get the audio from the packet
				if (!chan.muted) {			// We skip a muted channel in the mix
					let g = (chan.agc 		// Apply gain. If AGC use mix gain, else channel gain
						? mixOut.gain : chan.gain);	
					chan.gain = g;			// Channel gain level should reflect gain used here
					if (a.mono8.length > 0) {	// Only mix if there is audio in channel
						someAudio = true;	// Flag that there is actually some group audio
	  					for (let i=0; i < a.mono8.length; i++) t8[i] += a.mono8[i] * (g - 1/venueSize);	
					}				// NB: Fader = 0 means actually removing completely audio!
					if (a.mono16.length > 0) for (let i=0; i < a.mono16.length; i++) t16[i] += a.mono16[i] * (g - 1/venueSize);	
				}
			}
			if (c.sequence != (chan.seq + 1)) 		// Monitor audio transfer quality for all channels
				trace("Sequence jump Channel ",ch," jump ",(c.sequence - chan.seq));
			chan.seq = c.sequence;				// Store seq number for next time a packet comes in
		});
		if (someAudio) {					// If there is group audio rebuild and upsample it
			let k = 0;
			for (let i=0;i<t8.length;i++) {			// Reconstruct group mix gL[] from the MSRE blocks
				gL[k] = t8[i] + t16[i];k++;
				gL[k] = t8[i] - t16[i];k++;
			}						// Bring sample rate up to HW sample rate
			gL = reSample(gL, SampleRate, soundcardSampleRate, gCache); 
			gR = gL;					// Mono group audio FOR NOW!
		} 
		let s = Math.round(PacketSize * soundcardSampleRate / SampleRate);	// The amount of audio expected per server packet
		let mixL = new Array(s).fill(0), mixR = new Array(s).fill(0);
//		// TEMP COMBINE VENUE AND GROUP INTO MIX HERE
//		if (v.length > 0) {					// If there is venue audio
//			if (gL.length > 0) {				// and group audio, mix together
//				for (i=0; i<gL.length; i++) mixL = v[i] + gL[i];
//			} else mixL = v;				// only venue audio
//		} else if (gL.length > 0) mixL = gL;			// only group audio
		if (gL.length > 0) {mixL = gL; mixR = gR;}		// Put group audio in the mix if any
		// 3. Process performer audio if there is any, and add it to the mix. This could be stereo audio
		performer = (data.perf.chan == myChannel);		// Update performer flag just in case
		liveShow = data.perf.live;				// Update the live show flag to update display
		let isStereo = false;					// flag to indicate if we have stereo audio
		if ((data.perf.live) && (data.perf.packet != null)) {	// If there is a live performer with data, process it...
			let audio = zipson.parse(data.perf.packet.perfAudio);	// Uncompress performer audio
			let m8 = audio.mono8;
			let m16 = audio.mono16;
			let m32 = audio.mono32;
			if (!performer) {				// If we are not the performer 
				let mono = [];				// Reconstruct performer mono audio into this array
				let stereo = [];			// Reconstruct performer stereo difference signal into here
				let j = 0, k = 0;
				let sr = 32000;				// Sample rate can vary but it will break this code!
				if (m8.length == 0) {			// For some reason there is no audio
					let mono = new Array(250).fill(0);	// so generate silence
					sr = 8000;			// Set the sample rate and we're done
				} else if (m16.length == 0) {		// There is only 8kHz perf audio coming from server
					mono = m8;			// so just pass these 250 bytes through
					sr = 8000; 			
				} else if (m32.length == 0) {		// Standard quality audio 16kHz 500 bytes
					for (let i=0;i<m8.length;i++) {	// Reconstruct the 500 byte packet
						mono[k] = m8[i] + m16[i];k++;
						mono[k] = m8[i] - m16[i];k++;
					}
					sr = 16000; 
				} else for (let i=0; i<m8.length; i++) {// Best rate. 32kHz. Rebuild the 1k packet
					let s = m8[i] + m16[i];
					let d = m8[i] - m16[i];
					mono[k] = s + m32[j]; k++;
					mono[k] = s - m32[j]; j++; k++;
					mono[k] = d + m32[j]; k++;
					mono[k] = d - m32[j]; j++; k++;
				}					// Mono perf audio ready to upsample
				mono = reSample(mono, sr, soundcardSampleRate, upCachePerfM);
				let s8 = audio.stereo8;// Now regenerate the stereo difference signal
				let s16 = audio.stereo16;
				let s32 = audio.stereo32;
				if (s8.length > 0) {			// Is there a stereo signal in the packet?
					isStereo = true;
					j = 0, k = 0;
					if (s16.length == 0) {		// Low quaity stereo signal
						stereo = s8;
						sr = 8000;
					} else if (s32.length == 0) {	// Mid quality stereo signal
						for (let i=0;i<s8.length;i++) {	
							stereo[k] = s8[i] + s16[i];k++;
							stereo[k] = s8[i] - s16[i];k++;
						}
						sr = 16000; 
					} else for (let i=0; i<s8.length; i++) {
						let s = s8[i] + s16[i];	// Best stereo signal. Rebuild the 1k packet
						let d = s8[i] - s16[i];
						stereo[k] = s + s32[j]; k++;
						stereo[k] = s - s32[j]; j++; k++;
						stereo[k] = d + s32[j]; k++;
						stereo[k] = d - s32[j]; j++; k++;
					}				// Stereo difference perf audio upsampling now
					stereo = reSample(stereo, sr, soundcardSampleRate, upCachePerfS);
					let left = [], right = [];	// Time to reconstruct the original left and right audio
					for (let i=0; i<mono.length; i++) {	// Note. Doing this after upsampling because mono
						left[i] = (mono[i] + stereo[i])/2;	// and stereo may not have same sample rate
						right[i] = (mono[i] - stereo[i])/2;	// Divide by 2 because output is double input
					}
					if (mixL.length == 0) {		// If no venue or group audio just use perf audio directly
						mixL = left; mixR = right;
					} else {			// Have to build stereo mix
						for (let i=0; i < left.length; i++) {
							mixR[i] = mixL[i] + right[i];	// TEMP Mono group audio
							mixL[i] += left[i];	
						}
					}
				} else { 				// Just mono performer audio
					if (mixL.length == 0) {		// If no venue or group audio just use perf audio directly
						mixL = mono; 
					} else {			// Have to build mono mix
						for (let i=0; i < mono.length; i++) mixL[i] += mono[i];	
					}
					mixR = mixL;
				}
			} else ts = data.perf.packet.timestamp;		// I am the performer so grab timestamp for the rtt 
		}
		// 4. Adjust gain of final mix containing performer and group audio, and send to the speaker buffer
		var obj;
		if (isStereo) {
			let peakL = maxValue(mixL);			// Set gain according to loudest channel
			let peakR = maxValue(mixR);
			if (peakL > peakR) {
				obj = applyAutoGain(mixL, mixOut);	// Left sets the gain
				applyGain(mixR, obj.finalGain);		// and right follows
			} else {
				obj = applyAutoGain(mixR, mixOut);	// Right sets the gain
				applyGain(mixL, obj.finalGain);		// and left follows
			}
		} else obj = applyAutoGain(mixL, mixOut);		// For mono just use left channel
		mixOut.gain= obj.finalGain;				// Store gain for next loop
		if (obj.peak > mixOut.peak) mixOut.peak = obj.peak;	// Note peak for display purposes
		spkrBufferL.push(...mixL);				// put left mix in the left speaker buffer
		if (isStereo)
			spkrBufferR.push(...mixR);			// and the right in the right if stereo
		else
			spkrBufferR.push(...mixL);			// otherwise use the left
		if (spkrBufferL.length > maxBuffSize) {			// Clip buffers if too full
			spkrBufferL.splice(0, (spkrBufferL.length-maxBuffSize)); 	
			spkrBufferR.splice(0, (spkrBufferR.length-maxBuffSize)); 	
			overflows++;					// Note for monitoring purposes
		}
		if (v.length > 0)					// Add the venue audio to its own buffer
			venueBuffer.push(...v);				// Add any venue audio to the venue buffer
		if (venueBuffer.length > maxBuffSize) 			// Clip buffer if too full
			venueBuffer.splice(0, (venueBuffer.length-maxBuffSize)); 	
		// 5. Calculate RTT 
		if (ts > 0) {						// If we have timestamp data calcuate rtt
			let now = new Date().getTime();
			rtt = now - ts;					// Measure round trip time using a rolling average
			if (rtt1 == 0) rtt1 = rtt;
			else rtt1 = (9 * rtt1 + rtt)/10;
			rtt5 = (49 * rtt5 + rtt)/50;
		}
	}
	enterState( idleState );					// Back to Idling
});

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
});

var lastReset = new Date().getTime();					// Note previous socket reset to avoid excess resets
function resetConnection() {						// Use this to reset the socket if needed
	let now = new Date().getTime();
	if ((lastReset + 60000) < now) {				// 20 second minimum between socket resets
		trace2("Socket resetting...");
		socketIO.disconnect();
		socketIO.connect();
		lastReset = now
	}
}





// Media management and display code (audio in and out)
//
var displayRefresh = 100;						// mS between UI updates. MARK change to animation frame

function displayAnimation() { 						// called 100mS to animate audio displays
	enterState( UIState );						// Measure time spent updating UI
	const rate = 0.8;						// Speed of peak drop in LED level display
	if (micAccessAllowed) {						// Once we have audio we can animate audio UI
		mixOut.peak = mixOut.peak * rate; 			// drop mix peak level a little for smooth drops
		setLevelDisplay( mixOut );				// Update LED display for mix.peak
		setSliderPos( mixOut );					// Update slider position for mix gain
		micIn.peak = micIn.peak * rate; 			// drop mic peak level a little for smooth drops
		setLevelDisplay( micIn );				// Update LED display for mic.peak
		setSliderPos( micIn );					// Update slider position for mic gain
		setThresholdPos( micIn );
		for (let ch in channels) {				// Update each channel's UI
			c = channels[ch];
			if (c.name != "") {				// A channel needs a name to be active
				if (serverLiveChannels[ch] == null)	// Channel must have disconnected. 
					removeChannelUI(c);		// Remove its UI presence
				else {
					if (c.displayID == undefined)	// If there is no display associated to the channel
						createChannelUI(c);	// build the visuals 
					c.peak = c.peak * rate;		// drop smoothly the max level for the channel
					setLevelDisplay( c );		// update LED display for channel peak
					setSliderPos( c );		// update slider position for channel gain
				}
			}
		}
	}
	if (displayRefresh <= 1000)					// If CPU really struggling stop animating UI completely
		setTimeout(displayAnimation, displayRefresh);		// Call animated display again. 
	enterState( idleState );					// Back to Idling
}

function toggleSettings() {						// Hide/show settings = mixing desk
	let d = document.getElementById("mixerViewer");
	if (d.style.visibility == "hidden") {
		d.style.visibility = "visible";
		displayRefresh = 100;
		setTimeout(displayAnimation, displayRefresh);
	} else {
		d.style.visibility = "hidden";
		displayRefresh = 2000;
	}
}

function mapToLevelDisplay( n ) {					// map input to log scale in level display div
	let v = 0;
	if (n > 0.01) 
		v = (10.5 * Math.log10(n) + 21)*65/21;			// v=(10.5log(n)+21)65/21
	return v;
}

function setLevelDisplay( obj ) { 					// Set LED display level for obj
	let v = obj.peak;
	let h1, h2, h3;
	v = mapToLevelDisplay(v);
	if (v < 49.5) {h1 = v; h2 = 0; h3 = 0;} else
	if (v < 58.8) {h1 = 49.5; h2 = (v-49.5); h3 = 0;} else
			{h1 = 49.5; h2 = 9.3; h3 = (v-58.8);}
	let d = document.getElementById(obj.displayID+"LevelGreen");
	d.style.height = h1+"%";
	d = document.getElementById(obj.displayID+"LevelOrange");
	d.style.height = h2+"%";
	d = document.getElementById(obj.displayID+"LevelRed");
	d.style.height = h3+"%";
}

function setThresholdPos( obj ) {					// Set threshold indicator position
	let v = obj.threshold;
	if ((v > 0) && (v < 0.011)) v = 0.011;
	v =  mapToLevelDisplay(v);					// Modifying bottom edge so add 8
	let d = document.getElementById(obj.displayID+"Threshold");
	d.style.height = v+"%";
}

function setSliderPos( obj ) {
	let gain = obj.gain;						// With AGC slider shows actual gain, otherwise manual gain
	if (gain < 1) pos = (34 * gain) + 8; 
	else
		pos = (2.5 * gain) + 39.5;
	let sl = document.getElementById(obj.displayID + "Slider");
	sl.style.bottom = pos + "%" ;
}

function createChannelUI(obj) {						// build single channel UI with IDs using name requested
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:30%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:30%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function createOutputUI(obj) {						// UI for output channel
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:5%; top:9%;width:90%; padding-bottom:10%;object-fit: scale-down;visibility: hidden" src="images/live.png" id="'+name+'live" >  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function createMicUI(obj) {						// UI for mic input channel
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:5%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:5%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/talkOff.png" id="'+name+'talkOff" >  \
			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/talkOn.png" id="'+name+'talkOn" onclick="recButton(event)">  \
			<img style="position:absolute;right:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<img style="position:absolute;left:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/NROff.png" id="'+name+'NROff" ">  \
			<img style="position:absolute;left:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/NROn.png" id="'+name+'NROn" ">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function removeChannelUI(obj) {
	trace2("Removing channel ",obj.name);
	let chan = document.getElementById(obj.displayID);
	if (chan != null) chan.remove();				// Remove from UI
	obj.displayID	= undefined;					// Reset all variables except channel #
	obj.name 	= "";						
	obj.gain	= 1;					
	obj.agc		= true;				
	obj.muted	= false;		
	obj.peak	= 0;		
	obj.seq		= 0;
}

function convertIdToObj(id) {						// Translate HTML DOM IDs to JS data objects
	id = id.substring(2);
	if (parseFloat(id)) id = parseFloat(id);
	if ((typeof(id) == "number") || (id == "0")) {			// 0 seems not to come through as a number
		id = channels[id];					// ID is channel number so get the channel object
	} else {
		id = eval(id);						// Convert the ID to the object (micIn or mixOut)
	}
	return id;
}

function recButton(e) {
trace2("rec");
return;
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"talkOn");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	recording = true;
}

function muteButton(e) {
	let id = event.target.parentNode.id;
trace2("mute ",id);
	let b = document.getElementById(id+"On");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	id.muted = true;
}

function agcButton(e) {
	let id = event.target.parentNode.id;
	let oid = convertIdToObj(id);
	let b = document.getElementById(id+"AGCOn");
	if (oid.agc) {
		b.style.visibility = "hidden";
trace2("agc off");
	} else {
		b.style.visibility = "inherit";
trace2("agc on");
	}
	oid.agc = !oid.agc;
}

function unmuteButton(e) {
trace2("unmute");
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "inherit";
	id = convertIdToObj(id);
	id.muted = false;
}

var slider = {
	dragging:false,							// Flag if slider dragging is happening
	dragStartY:0,							// Y coord where dragging started
	dragStartPct:0,							// start % from bottom for dragged slider
};

function sliderDragStart(event) {
	slider.dragging = true;
	event.target.style.cursor='pointer';				// Make pointer look right
	slider.dragStartY = event.clientY;				// Store where the dragging started
	if (isNaN(slider.dragStartY)) 
		slider.dragStartY = event.touches[0].clientY;		// If it is NaN must be a touchscreen
	let id = event.target.parentNode.id;
	let o = document.getElementById(id+"Slider");
	slider.dragStartPct = parseFloat(o.style.bottom);		// Get the slider's current % position
}

function sliderDrag(event) {
	if (slider.dragging) {
		let y = event.clientY;					// Get current cursor Y coord
		if (isNaN(y)) y = event.touches[0].clientY;		// If it is NaN we must be on a touchscreen
		y = (slider.dragStartY - y);				// Get the cursor positon change
		let pct = (y/event.target.clientHeight*0.65)*100;	// Calculate the change as a % of the range (0.65 is a fudge... coords are wrong but life is short)
		p = slider.dragStartPct + pct;				// Apply the change to the initial position
		let id = event.target.parentNode.id;
		let o = document.getElementById(id+"Slider");
		if (p < 8) p = 8;					// Limit slider movement
		if (p > 65) p = 65;
		o.style.bottom = p;					// Move the slider to the desired position
		let agc = document.getElementById(id+"AGCOn");
		agc.style.visibility = "hidden";				// By sliding the fader AGC is switched off. Hide indicator
		let gain;						// Now calculate the gain this position implies
		if (p < 42) 						// Inverse equations used for slider positioning
			gain = (p -8)/34;
		else
			gain = (p - 39.5)/2.5;
		id = convertIdToObj(id);				// Get the js object ID for this UI element
		id.gain = gain;						// Set the object's gain level 
//		if (id.targetGain != undefined) id.targetGain = gain;	// If this object has a target gain manually set it too
		id.agc = false;						// AGC is now off for this object
	}
}

function sliderDragStop(event) {
	event.target.style.cursor='default';
	slider.dragging = false;
}

function setStatusLED(name, level) {					// Set the status LED's colour
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
}




// Audio management code
//

function maxValue( arr ) { 						// Find max value in an array
	let max = 0;	
	let v;
	for (let i =  0; i < arr.length; i++) {
		v = Math.abs(arr[i]);					// max ABSOLUTE value
		if (v > max) max = v;
	}
	return max;
}

function avgValue( arr ) { 						// Find average value in an array
	let t = 0;
	for (let i =  0; i < arr.length; i++) {
		t += Math.abs(arr[i]);					// average ABSOLUTE value
	}
	return (t/arr.length);
}

function applyAutoGain(audio, obj) {
	let startGain = obj.gain;
	let targetGain = obj.targetGain;
	let ceiling = obj.ceiling;
	let negCeiling = ceiling * -1;
	let gainRate = obj.gainRate;
	let agc = obj.agc;
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	if (!agc) targetGain = startGain;				// If no AGC not much to do. Just clip and apply ceiling
	maxLevel = maxValue(audio);					// Find peak audio level 
	endGain = ceiling / maxLevel;					// Our endGain can never exceed this to avoid overload
	maxLevel = 0;							// Use this to capture peak
	if (endGain > targetGain) endGain = targetGain;			// endGain is the max, but if target is lower then use that
	else {
//		obj.gainRate = 10000;					// clipping! slow gain increases - set obj value
		trace2("Clipping gain");
	}
	if (endGain >= startGain) {					// Gain adjustment speed varies
		transitionLength = audio.length;			// Gain increases are over entire sample
		if (agc) endGain = startGain 				// and, if using AGC, are very gentle
			+ ((endGain - startGain)/gainRate);	 	
	}
	else {
		transitionLength = Math.floor(audio.length/10);		// Gain decreases are fast
		trace2("Gain dropping");
	}
	tempGain = startGain;						// Start at current gain level
	for (let i = 0; i < transitionLength; i++) {			// Adjust gain over transition
		x = i/transitionLength;
//		if (i < (2*transitionLength/3))				// Use the Magic formula
//			p = 3*x*x/2;					
//		else
//			p = -3*x*x + 6*x -2;
//		tempGain = startGain + (endGain - startGain) * p;
		tempGain = startGain + (endGain - startGain) * x;
	 	audio[i] = audio[i] * tempGain;
		if (audio[i] >= ceiling) audio[i] = ceiling;
		else if (audio[i] <= negCeiling) audio[i] = negCeiling;
		x = Math.abs(audio[i]);
		if (x > maxLevel) maxLevel = x;
	}
	if (transitionLength != audio.length) {				// Still audio left to adjust?
		tempGain = endGain;					// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++) {
			audio[i] = audio[i] * tempGain;
			if (audio[i] >= ceiling) audio[i] = ceiling;
			else if (audio[i] <= negCeiling) audio[i] = negCeiling;
			x = Math.abs(audio[i]);
			if (x > maxLevel) maxLevel = x;
		}
	}
	if (ceiling != 1) endGain = startGain;				// If talkover ceiling impact on gain is temporary
	return { finalGain: endGain, peak: maxLevel };
}

function applyGain( audio, gain ) {					// Apply a simple gain level to a sample
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * gain;
}

function fadeUp(audio) {						// Fade sample linearly over length
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * (i/audio.length);
}

function fadeDown(audio) {						// Fade sample linearly over length
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * ((audio.length - i)/audio.length);
}

var talkoverLevel = 0.01;						// Ceiling for mix when mic is active, 0 = half duplex
if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) 		// If we are on Firefox echo cancelling is good 
	talkoverLevel = 1;
var talkoverLag = 50;							// mS that talkover endures after mic goes quiet
var talkoverTimer = 0;							// timer used to slow talkover lift off
function talkover() {							// Suppress mix level while mic is active
	let now = new Date().getTime();
	talkoverTimer = now + talkoverLag;			
	mixOut.ceiling = talkoverLevel;
}

function endTalkover() {
	let now = new Date().getTime();
	if (now > talkoverTimer) { 					// Mix ceiling can raise after timeout
		mixOut.ceiling = 1;
	}
}

var thresholdBands = [0.0001, 0.0002, 0.0003, 0.0005, 0.0007, 0.001, 0.002, 0.003, 0.005, 0.007, 0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.2, 0.3, 0.5, 0.7, 1, 2];
var levelCategories = new Array(thresholdBands.length).fill(0);		// Categorizer to build histogram of packet levels
function levelClassifier( v ) {
	for (let i=0; i<thresholdBands.length; i++) {
		if (v < thresholdBands[i]) {
			levelCategories[i]++;
			break;
		}
	}
}

var noiseThreshold = 0.02;							// Base threshold for mic signal
function setNoiseThreshold () {						// Set the mic threshold to remove most background noise
	let max = 0;
	for (let i=0; i<14; i++)
		if (levelCategories[i] > max) {				// Find the peak category for sample levels
			max = levelCategories[i];
			noiseThreshold = thresholdBands[i];		// Threshold set to remove all below the peak
		}
	noiseThreshold = noiseThreshold * 1.2;				// Give noise threshold a little boost
trace2("Noise threshold: ",noiseThreshold);
	if (max > 0)
		for (let i=0; i<14; i++)
			levelCategories[i] = 
				((levelCategories[i]/max)*100.0);	// Keep old data to obtain slower threshold changes
}

var thresholdBuffer = new Array(20).fill(0);				// Buffer dynamic thresholds here for delayed mic muting
var gateDelay = 30;							// Amount of samples (time) the gate stays open

function processAudio(e) {						// Main processing loop
	// There are two activities here (if not performing an echo test that is): 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker
	
	enterState( audioInOutState );					// Log time spent here

	var inDataL = e.inputBuffer.getChannelData(0);			// Audio from the left mic
	var inDataR = e.inputBuffer.getChannelData(1);			// Audio from the right mic
	var outDataL = e.outputBuffer.getChannelData(0);		// Audio going to the left speaker
	var outDataR = e.outputBuffer.getChannelData(1);		// Audio going to the right speaker
	var outDataV = e.outputBuffer.getChannelData(2);		// Venue audio going to be processed

	if (echoTest.running == true) {					// The echo test takes over all audio
		let output = runEchoTest(inDataL);			// Send the mic audio to the tester
		for (let i in output) {					// and get back audio to reproduce
			outDataL[i] = output[i];			// Copy audio to output
			outDataR[i] = output[i];			// Copy audio to output
		}
		enterState( idleState );				// This test stage is done. Back to Idling
		return;							// Don't do anything else while testing
	} 

	// 1. Get Mic audio, buffer it, and send it to server if enough buffered
	if (socketConnected) {						// Need connection to send
		let micAudioL = [];					// Our objective is to fill this with audio
		let micAudioR = [];					
		let peak = maxValue(inDataL);				// Get peak of raw mic audio (using left channel for now)
		if (!pauseTracing) levelClassifier(peak);		// Classify audio incoming for analysis
		if ((peak > micIn.threshold) &&				// if audio is above dynamic threshold
			(peak > noiseThreshold)) {			// and noise threshold, open gate
			if (micIn.gate == 0)
				micIn.gate = gateDelay + 1;		// This signals the gate has just been reopened
			else						// which means fade up the sample (not done anymore)
				micIn.gate = gateDelay;
		} 
		if (performer) micIn.gate = 1				// Performer's mic is always open
		if (micIn.gate > 0) {					// If gate is open prepare the audio for sending
			micAudioL = inDataL;
			micAudioR = inDataR;
			micIn.gate--;					// Gate slowly closes
		} else {						// Gate closed. Fill with silence.
			micAudioL = new Array(inDataL.length).fill(0);
			micAudioR = new Array(inDataL.length).fill(0);
		}
		micBufferL.push(...micAudioL);				// Buffer mic audio L
		micBufferR.push(...micAudioR);				// Buffer mic audio R
		if (micBufferL.length > micAudioPacketSize) {		// If enough audio in buffer 
			let audioL = micBufferL.splice(0, micAudioPacketSize);		// Get a packet of audio
			let audioR = micBufferR.splice(0, micAudioPacketSize);		// for each channel
			let audio = {mono8:[],mono16:[]};		// default empty audio and perf objects to send
			let perf = zipson.stringify({mono8:[],mono16:[],mono32:[],stereo8:[],stereo16:[],stereo32:[]});
			let peak = 0;					// Note: no need for perf to set peak
			if (performer) {				// If we are the performer 
				if (!micIn.muted) {			// & not muted prepare our audio for HQ stereo 
					let a = prepPerfAudio(audioL, audioR);	
					perf = zipson.stringify(a);	// and compress audio fully
				}
			} else {					// Standard audio prep - always mono
				let mono8 = [], mono16 = [], mono32 = [], stereo8 = [], stereo16 = [], stereo32 = [];
				audio = reSample(audioL, soundcardSampleRate, SampleRate, downCache);	
				let obj = applyAutoGain(audio, micIn);	// Amplify mic with auto limiter
				if (obj.peak > micIn.peak) 
					micIn.peak = obj.peak;		// Note peak for local display
				peak = obj.peak				// peak for packet to be sent
				micIn.gain = obj.finalGain;		// Store gain for next loop
				if ((peak == 0) || (micIn.muted) || 	// Send empty packet if silent, muted
					(serverMuted)) { 		// or muted by server 
					peak = 0;
				} else {
					let j=0, k=0, s, d;
					for (let i=0; i<audio.length; i+=2) {	// Multiple sample-rate encoding:
						s = (audio[i] + audio[i+1])/2;	// Organises audio such that the server
						d = (audio[i] - audio[i+1])/2;	// can choose to reduce BW use
						mono8[j] = s;			// removing high frequencies from audio
						mono16[j] = d; j++		// just by ignoring data
					}
				}
				audio = {mono8,mono16,mono32,stereo8,stereo16,stereo32};	
				let a = zipson.stringify(audio);		// Compressing and uncompressing
				audio = zipson.parse(a);			// Saves 65% of bandwidth on its own!
			}
			let sr = performer ? PerfSampleRate : SampleRate;
			let now = new Date().getTime();
			let packet = {
				name		: myName,		// Send the name we have chosen 
				audio		: audio,		// Audio block
				perfAudio	: perf,			// Performer audio block
				liveClients	: 1,			// This is audio from a single client
				sequence	: packetSequence,	// Usefull for detecting data losses
				timestamp	: now,			// Used to measure round trip time
				peak 		: peak,			// Saves others having to calculate again
				channel		: myChannel,		// Send assigned channel to help server
				recording	: recording,		// Flag used for recording - test function
				sampleRate	: sr,			// Send sample rate to help processing
				group		: myGroup,		// Group name this user belings to
				rtt		: rtt1,			// Send my rtt measurement for server monitoring
			};
			socketIO.emit("u",packet);
			let len=JSON.stringify(packet).length/1024;
			bytesSent += len;
			if (!performer) packetBuf.push(packet);		// If not performer add packet to buffer for echo cancelling 
			packetsOut++;					// For stats and monitoring
			packetSequence++;
		}
	}

	// 2. Take audio buffered from server and send it to the speaker
	let outAudioL = [], outAudioR = [];					
	if (spkrBufferL.length > ChunkSize) {				// There is enough audio buffered
		outAudioL = spkrBufferL.splice(0,ChunkSize);		// Get same amount of audio as came in
		outAudioR = spkrBufferR.splice(0,ChunkSize);		// for each channel
	} else {							// Not enough audio.
		outAudioL = spkrBufferL.splice(0,spkrBufferL.length);	// Take all that remains and complete with 0s
		outAudioR = spkrBufferR.splice(0,spkrBufferR.length);	// Take all that remains and complete with 0s
		let zeros = new Array(ChunkSize-spkrBufferL.length).fill(0);
		outAudioL.push(...zeros);
		outAudioR.push(...zeros);
		shortages++;						// For stats and monitoring
	}
	for (let i in outDataL) { 
		outDataL[i] = outAudioL[i];				// Copy left audio to outputL
		outDataR[i] = outAudioR[i];				// and right audio to outputR
	}
	// 2.1 Take venue audio from buffer and send to special output
	let outAudioV = [];
	if (venueBuffer.length > ChunkSize) {				// There is enough audio buffered
		outAudioV = venueBuffer.splice(0,ChunkSize);		// Get same amount of audio as came in
	} else {							// Not enough audio.
		outAudioV = venueBuffer.splice(0,venueBuffer.length);	// Take all that remains and complete with 0s
		let zeros = new Array(ChunkSize-venueBuffer.length).fill(0);
		outAudioV.push(...zeros);
	}
	for (let i in outDataV) { 
		outDataV[i] = outAudioV[i];				// Copy venue audio to it's special output
	}
	// 2.2 Get highest level output and use it to set the dynamic threshold level to stop audio feedback
	let maxL = maxValue(outAudioL);					// Get peak level of this outgoing audio
	let maxR = maxValue(outAudioR);					// for each channel
	let maxV = maxValue(outAudioV);					// and venue audio
	if (maxL < maxR) maxL = maxR;					// Choose loudest channel
	if (maxL < maxV) maxL = maxV;					
	thresholdBuffer.unshift( maxL );				// add to start of dynamic threshold queue
	micIn.threshold = (maxValue([					// Apply most aggressive threshold near current +/-2 chunks
		thresholdBuffer[echoTest.sampleDelay-2],
		thresholdBuffer[echoTest.sampleDelay-1],
		thresholdBuffer[echoTest.sampleDelay],	
		thresholdBuffer[echoTest.sampleDelay+1],
		thresholdBuffer[echoTest.sampleDelay+2]
	])) * echoTest.factor * mixOut.gain;				// multiply by factor and mixOutGain
	thresholdBuffer.pop();						// Remove oldest threshold buffer value

	enterState( idleState );					// We are done. Back to Idling
}

function prepPerfAudio( audioL, audioR ) {				// Performer audio is HQ and possibly stereo
	let stereo = false;						// Start by detecting is there is stereo audio
	for (let i=0; i<audioL.length; i++) 
		if (audioL[i] != audioR[i]) stereo = true;
	audioL = reSample(audioL, soundcardSampleRate, PerfSampleRate, downCachePerfL);	
	if (stereo) {							// If stereo the right channel will need processing
		audioR = reSample(audioR, soundcardSampleRate, PerfSampleRate, downCachePerfR);	
	}
	let obj;
	if (stereo) {							// Stereo level setting 
		let peakL = maxValue(audioL);				// Set gain according to loudest channel
		let peakR = maxValue(audioR);
		if (peakL > peakR) {
			obj = applyAutoGain(audioL, micIn);		// Left sets the gain
			applyGain(audioR, obj.finalGain);		// and right follows
		} else {
			obj = applyAutoGain(audioR, micIn);		// Right sets the gain
			applyGain(audioL, obj.finalGain);		// and left follows
		}
	} else obj = applyAutoGain(audioL, micIn);			// For mono just use left channel
	if (obj.peak > micIn.peak) 
		micIn.peak = obj.peak;					// Note peak for local display
	micIn.gain = obj.finalGain;					// Store gain for next loop
	let LplusR = [], LminusR = [];					// Build mono and stereo (difference) data
	if (stereo) for (let i=0; i<audioL.length; i++) {
		LplusR[i] = audioL[i] + audioR[i];
		LminusR[i] = audioL[i] - audioR[i];
	} else LplusR = audioL;						// Just use the left signal if mono
	let mono8 = [], mono16 = [], mono32 = [], stereo8 = [], stereo16 = [], stereo32 = [];
	let j=0, k=0; 
	for (let i=0; i<LplusR.length; i+=4) {				// Multiple sample-rate encoding:
		let s1,s2,d1,d2,s3,d3;					// This encoding allows the server to discard blocks
		s1 = (LplusR[i] + LplusR[i+1])/2;			// and reduce network load by simply reducing the
		d1 = (LplusR[i] - LplusR[i+1])/2;			// high frequency content of performer audio
		s2 = (LplusR[i+2] + LplusR[i+3])/2;
		d2 = (LplusR[i+2] - LplusR[i+3])/2;
		s3 = (s1 + s2)/2;
		d3 = (s1 - s2)/2;
		mono8[j] = s3;
		mono16[j] = d3; j++
		mono32[k] = d1; k++;
		mono32[k] = d2; k++;
	}
	j=0, k=0;
	if (stereo) for (let i=0; i<LminusR.length; i+=4) {		// Repeat MSRE for stereo difference audio
		let s1,s2,d1,d2,s3,d3;		
		s1 = (LminusR[i] + LminusR[i+1])/2;	
		d1 = (LminusR[i] - LminusR[i+1])/2;
		s2 = (LminusR[i+2] + LminusR[i+3])/2;
		d2 = (LminusR[i+2] - LminusR[i+3])/2;
		s3 = (s1 + s2)/2;
		d3 = (s1 - s2)/2;
		stereo8[j] = s3;
		stereo16[j] = d3; j++
		stereo32[k] = d1; k++;
		stereo32[k] = d2; k++;
	}
	let audio = {mono8,mono16,mono32,stereo8,stereo16,stereo32};	// Return an object for the audio
	return audio;
}

var micFilter1;
var micFilter2;
function handleAudio(stream) {						// We have obtained media access
	let context;
	let AudioContext = window.AudioContext 				// Default
		|| window.webkitAudioContext 				// Safari and old versions of Chrome
		|| false; 
	if (AudioContext) {
		context = new AudioContext();
	} else {
		alert("Sorry, the Web Audio API is not supported by your browser. Consider upgrading or using Google Chrome or Mozilla Firefox");
	}
	soundcardSampleRate = context.sampleRate;			// Get HW sample rate... varies per platform
	micAudioPacketSize = Math.round( soundcardSampleRate 		// How much micAudio is needed to fill a Packet
		/ (SampleRate/PacketSize) );				// at our standard SampleRate (rounding error is an issue?)
	micAccessAllowed = true;
	createOutputUI( mixOut );					// Create the output mix channel UI
	createMicUI( micIn );						// Create the microphone channel UI
	let liveSource = context.createMediaStreamSource(stream); 	// Create audio source (mic)
	let node = undefined;
	if (!context.createScriptProcessor) {				// Audio processor node
		node = context.createJavaScriptNode(ChunkSize, 2, 3);	// The new way is to use a worklet
	} else {							// but the results are not as good
		node = context.createScriptProcessor(ChunkSize, 2, 3);	// and it doesn't work everywhere
	}
	node.onaudioprocess = processAudio;				// Link the callback to the node

	micFilter1 = context.createBiquadFilter();
	micFilter1.type = 'lowpass';
	micFilter1.frequency.value = HighFilterFreq;
	micFilter1.Q.value = 1;
	micFilter2 = context.createBiquadFilter();
	micFilter2.type = 'highpass';
	micFilter2.frequency.value = LowFilterFreq;
	micFilter2.Q.value = 1;
	
	let reverbL = context.createConvolver();
	let reverbR = context.createConvolver();
	let combinerL = context.createChannelMerger(2);
	let combinerR = context.createChannelMerger(2);

	liveSource.connect(micFilter1);					// Mic goes to the lowpass filter (both stereo)
	micFilter1.connect(micFilter2);					// then to the highpass filter (stereo)
	micFilter2.connect(node);					// then to the node where all the work is done (stereo in/out plus venue out)
	node.connect(combinerL,0,0);
	node.connect(combinerR,1,0);
//	node.connect(reverbL,2,0);					// connect the venue output to the left reverb
//	node.connect(reverbR,2,0);					// and the right reverb
//	reverbL.connect(context.destination,0,0);			// Connect the left reverb to the left output
//	reverbR.connect(context.destination,0,1);			// and the right reverb to the right output
//	node.connect(combinerL,2,1);			
//	node.connect(combinerR,2,1);		
//	combinerL.connect(context.destination,0,0);			
//	combinerR.connect(context.destination,0,1);		

	startEchoTest();
}


	
document.addEventListener('DOMContentLoaded', function(event){
	initAudio();							// Call initAudio() once loaded
});

function initAudio() {							// Set up all audio handling here
	let constraints = { 						// Try to get the right audio setup
		mandatory: {						// These don't really work though!
 			googEchoCancellation: false,
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


// Resampler
//
var  downCache = [0.0,0.0];						// Resampling cache for audio from mic
var  vCache = [0.0,0.0];						// cache for venue mix to speaker
var  gCache = [0.0,0.0];						// cache for group mix to speaker
var  downCachePerfL = [0.0,0.0];					// cache for performer audio from mic
var  downCachePerfR = [0.0,0.0];					// can be stereo
var  upCachePerfM = [0.0,0.0];						// cache for performer audio to mix and send to speaker
var  upCachePerfS = [0.0,0.0];						// can be stereo
function reSample( buffer, originalSampleRate, resampledRate, cache) {
	let resampledBufferLength = Math.floor( buffer.length * resampledRate / originalSampleRate );
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( let i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = cache[ 1 + tap ];
				if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	cache[ 0 ] = buffer[ buffer.length - 2 ];
	cache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
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






// Echo testing code
//
var echoTest = {
	running		: false,
	steps		: [16,8,128,64,32,1,0.5,0.2,0.1,0.05,0.02,0],	// Test frequencies and levels ended with 0
	currentStep	: 0,						// Points to test step being executed
	analysisStep	: 0,						// Points to test step being analysed
	tones		: [],						// Tones for each test are held here
	samplesNeeded 	: 0,						// Indicates how many samples still to store
	results		: [],						// Samples of each test buffer here
	delays 		: [],						// Array of final measurements
	delay		: 129,	// Default value			// Final delay measurement result stored here
	factor		: 2,	// Default value			// Final sensitivity factor stored here
	sampleDelay	: 6,	// Default value			// Final number of samples to delay dynamic threshold by
};

echoTest.steps.forEach(i => {						// Build test tones
	if (i>1) {							// Create waves of different frequencies
		let halfWave = ChunkSize/(i*2);
		let audio = [];
		for  (let s=0; s < ChunkSize; s++) {
			audio.push(Math.sin(Math.PI * s / halfWave));
		}
		echoTest.tones[i] = audio;
	} else if (i > 0) {						// Create 1411Hz waves at different levels
		let halfWave = ChunkSize/64;
		let audio = [];
		let gain = i;
		for  (let s=0; s < ChunkSize; s++) {
			audio.push(gain * Math.sin(Math.PI * s / halfWave));
		}
		echoTest.tones[i] = audio;
	}
});

function startEchoTest() {						// Test mic-speaker echo levels
	if (echoTest.running == false) {				// If not testing already
		trace2("Starting echo test");
		echoTest.running = true;				// start testing
		echoTest.currentStep = 0;				// start at step 0 and work through list
		echoTest.analysisStep = 0;				// reset the analysis pointer too
		echoTest.results = [];					// clear out results for new test
		echoTest.delays = [];					// clear out final mesaurements too
	}
}

function runEchoTest(audio) {						// Test audio system in a series of tests
	let outAudio;
	let test = echoTest.steps[echoTest.currentStep];
	if (test > 0) {							// 0 means analyze. >0 means emit & record audio
		if (echoTest.samplesNeeded == 0) {			// If not storing audio must be sending test sound
			trace2("Running test ",test);
			outAudio = echoTest.tones[test]; 		// Get test sound for this test
			echoTest.results[test] = [];			// Get results buffer ready to store audio
			echoTest.samplesNeeded = 10;			// Request 10 audio samples for each test
		} else {						// else samples need to be buffered
			echoTest.results[test].push(...audio);
			outAudio = new Array(ChunkSize).fill(0);	// return silence to send to speaker
			echoTest.samplesNeeded--;			// One sample less needed
			if (echoTest.samplesNeeded == 0)		// If no more samples needed
				echoTest.currentStep++;			// move to next step
		}
	} else {							// Test completed. "0" indicates analysis phase.
		let review = echoTest.steps[echoTest.analysisStep];
		if (review > 0) {					// >0 means reviewing a test
			let results = echoTest.results[review];
			let name = "test " + review;
			trace2("Analyzing ",name);
			let pulse = echoTest.tones[review];
			let plen = pulse.length;
			let conv = [];					// convolution output
			for (let p=0; p<(results.length-plen); p++) {	// Run the convolution over results
				let sum = 0;
				for (let x=0; x<plen; x++) {
					sum += results[p+x]*pulse[x];
				}
				conv.push(sum);				// push each result to output
			}
			let max = 0;
			let edge = 0;
			for (let j=0; j<conv.length; j++)			// Find max = edge of pulse
				if (conv[j] > max) {
					max = conv[j];
					edge = j;
				}
			let delay = Math.round((edge*100)/soundcardSampleRate)*10;	// convert result to nearest 10mS
			trace2("Pulse delay is ",delay,"mS");
			echoTest.delays.push(delay.toFixed(0));		// Gather results n mS for each step
//			for (j=0; j<conv.length; j++)			// Normalize output for graphs
//				conv[j] = conv[j]/max;
//			drawWave(results,name,(edge*100/results.length));
		} else {						// All tests have been analyzed. Get conclusions.
			trace2("Reviewing results");
			let counts = [];				// Collate results on mS values
			echoTest.delays.forEach(d => {if (counts[d] == null) counts[d] = 1; else counts[d]++});
			let max = 0;
			let winner = false;
			for (let c in counts) {				// Find most agreed on result (mode)
				if (counts[c] > max) max = counts[c];
				if ((c > 0) && (counts[c] > 5)) {
					trace2("Delay is ",c);
					winner = true;
					echoTest.delay = c;		// Store final delay result
					echoTest.sampleDelay = Math.ceil((echoTest.delay * soundcardSampleRate / 1000)/1024)
					trace2("Sample delay is ",echoTest.sampleDelay);
				}
			}
			if (winner) {					// If delay obtained calculate gain factor
				// Convert delay back to samples as start point for averaging level
				let edge = Math.round(echoTest.delay * soundcardSampleRate / 1000);
				let factors = [];			// Buffer results here
				// for each test <= 1 get avg level from edge for 1024 samples and get factor
				for (let i=0; i<(echoTest.steps.length-1); i++) {
					let t = echoTest.steps[i];
					if (t <= 1) {			// Level tests are <= 1
						let data = echoTest.results[t].slice(edge, (edge+1024));
						let avg = avgValue(data);
						let factor = avg/(t * 0.637);	// Avg mic signal vs avg output signal
						trace2("Test ",echoTest.steps[i]," Factor: ",factor);
						factors.push(factor);	// Store result in buffer
					}
				}
				// Get average factor value
				echoTest.factor = avgValue(factors) * 3; // boost factor to give echo margin
				echoTest.factor = 2;			// Force strong factor always
				trace2("Forced factor is ",echoTest.factor);
			} else {
				trace2("No clear result");		// No agreement, no result
				if (max > 3)
					trace2("It may be worth repeating the test");
			}
			echoTest.running = false;			// Stop test 
		}
		echoTest.analysisStep++;				// Progress to analyze next step
	}
	return outAudio;
}

function drawWave(audio,n,d) {
	let str = '<div id="'+n+'" style="position:absolute; bottom:10%; right:5%; width:80%; height:80%; background-color: #222222; visibility: hidden">'+n;
	let max = 0;
	for (let i=0; i<audio.length;i++) {audio[i] = Math.abs(audio[i]); if (audio[i] > max) max = audio[i];}
	for (let i=4;i<(audio.length-4);i++) {
		let l = (i*100)/audio.length;
		let b = 50 + 50*audio[i];
		str += '<div style="position:absolute; bottom:'+b+'%;left:'+l+'%;width:1px;height:1px;background-color:#66FF33"></div>';
	}
	max = 50 + 50*max;
	str += '<div style="position:absolute; bottom:'+max+'%;left:0%;width:100%;height:1px;background-color:#FF0000">'+max+'</div>';
	str += '<div style="position:absolute; bottom:0%;left:'+d+'%;width:1px;height:100%;background-color:#FF0000"></div>';
	str += '</div>';
	let container = document.getElementById("graphs");
	container.innerHTML += str;
	monitors.push(n);
}







// Tracing, monitoring, reporting and debugging code
// 
var currentMonitor=0;
var monitors = ["none","monitor","monitor2"];
document.addEventListener('DOMContentLoaded', function(event){
	let monitorBtn=document.getElementById('monitorBtn');
	monitorBtn.onclick = function () {
		if (monitors[currentMonitor] != "none") {
			let mon = document.getElementById(monitors[currentMonitor])
			mon.style.visibility = "hidden";
			mon.parentNode.style.visibility = "hidden";
		}
		currentMonitor++;
		if (currentMonitor == monitors.length) currentMonitor = 0;
		if (monitors[currentMonitor] != "none") {
			let mon = document.getElementById(monitors[currentMonitor])
			mon.style.visibility = "visible";
			mon.parentNode.style.visibility = "visible";
		}
	};
	let settingsBtn=document.getElementById('settingsBtn');
	settingsBtn.onclick = function () {
		trace2("Settings Button Pressed");
		toggleSettings();
	};
	// Buttons used for testing...
	let testBtn=document.getElementById('testBtn');
	testBtn.onclick = function () {
		trace2("Echo Test Button Pressed");
		startEchoTest();
	};
	let actionBtn=document.getElementById('actionBtn');
	actionBtn.onclick = function () {
//		trace("Reset connection pressed");
//		resetConnection();
		trace("Pause traces pressed");
		if (pauseTracing == true) pauseTracing = false;
		else pauseTracing = true;
	};
});
var pauseTracing = true;						// Traces are off by default

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var bytesSent = 0;
var bytesRcvd = 0;
var overflows = 0;
var shortages = 0;
var packetSequence = 0;							// Tracing packet ordering
var tracecount = 0;
var sendShortages = 0;
function printReport() {
	enterState( UIState );						// Measure time spent updating UI even for reporting!
	let netState = ((((rtt1-rtt5)/rtt5)>0.1) && (rtt5>400)) ? "UNSTABLE":"stable";
	if (!pauseTracing) {
		trace("Idle=", idleState.total, " data in=", dataInState.total, " audio in/out=", audioInOutState.total," UI work=",UIState.total);
		trace("Sent=",packetsOut," Heard=",packetsIn," overflows=",overflows," shortages=",shortages," RTT=",rtt.toFixed(1)," RTT1=",rtt1.toFixed(1)," RTT5=",rtt5.toFixed(1)," State=",netState," audience=",audience," bytes Out=",bytesSent.toFixed(1)," bytes In=",bytesRcvd.toFixed(1));
		trace(" micIn.peak:",micIn.peak.toFixed(1)," mixOut.peak:",mixOut.peak.toFixed(1)," speaker buff:",spkrBufferL.length," Max Buff:",maxBuffSize);
//		trace("Levels of output: ",levelCategories);
	}
//	setNoiseThreshold();						// Set mic noise threshold based on level categories
	if (performer == true) {
		document.getElementById("onair").style.visibility = "visible";
		micFilter1.frequency.value = PerfSampleRate/2.2;	// Change mic filter for performance audio
		micFilter2.frequency.value = 30;
	} else	{
		document.getElementById("onair").style.visibility = "hidden";
		micFilter1.frequency.value = HighFilterFreq		// Return mic filter to normal settings
		micFilter2.frequency.value = LowFilterFreq;
		if (liveShow)
			document.getElementById("live").style.visibility = "visible";
		else
			document.getElementById("live").style.visibility = "hidden";
	}
	if (liveShow)
		document.getElementById("ID"+mixOut.channel+"live").style.visibility = "inherit";
	else
		document.getElementById("ID"+mixOut.channel+"live").style.visibility = "hidden";
	let generalStatus = "Green";
	if ((overflows > 1) || (shortages >1) || (netState != "stable")) generalStatus = "Orange";
	if (socketConnected == false) generalStatus = "Red";
	setStatusLED("GeneralStatus",generalStatus);
	let upperLimit = SampleRate/PacketSize * 1.2;
	let lowerLimit = SampleRate/PacketSize * 0.8;
	let upStatus = "Green";
	if ((packetsOut < lowerLimit) || (packetsOut > upperLimit)) upStatus = "Orange";
	if (packetsOut < lowerLimit/3) upStatus = "Red";
	setStatusLED("UpStatus",upStatus);
	let downStatus = "Green";
	if ((packetsIn < lowerLimit) || (packetsIn > upperLimit)) downStatus = "Orange";
	if (packetsIn < lowerLimit/3) downStatus = "Red";
	setStatusLED("DownStatus",downStatus);
	if ((overflows > 2) || (shortages > 2)) 
		if (maxBuffSize < 20000) maxBuffSize += 100;		// Increase speaker buffer size if we are overflowing or short
	if (maxBuffSize > 6000) maxBuffSize -= 20;			// Steadily drop buffer back to size to compensate
	packetsIn = 0;
	packetsOut = 0;
	bytesSent = 0;
	bytesRcvd = 0;
	overflows = 0;
	shortages = 0;
	rtt = 0;
	tracecount = 1;
	enterState( idleState );					// Back to Idling
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
var UIState = new stateTimer();	UIState.name = "UI updating";
var currentState = idleState;		currentState.start = new Date().getTime();
function enterState( newState ) {
	let now = new Date().getTime();
	currentState.total += now - currentState.start;
	newState.start = now;
	currentState = newState;
}



// SVG analysis testing...
//
window.addEventListener("load", function(event){
	deriveTree();							
});

function deriveTree() {
	let svg = document.getElementById('venue');
	if (svg == null) return;
	svg = svg.contentDocument;
	let kids = svg.getElementsByClassName("selectable");
	kids = svg.getElementsByTagName("rect"); 
	for (var i=0,len=kids.length;i<len;++i) {
		let kid = kids[i];
		if (kid.nodeType!=1) continue;
		switch(kid.nodeName){
			case 'circle':
			break;
			case 'rect':
				let x = parseFloat(kid.getAttributeNS(null,'x'));
				let y = parseFloat(kid.getAttributeNS(null,'y'));
				let width = parseFloat(kid.getAttributeNS(null,'width'));
				let height = parseFloat(kid.getAttributeNS(null,'height'));
				let ID = kid.getAttributeNS(null,'id');
console.log("Found a rectangle");
console.log(x,y,width,height,ID);
			break;
		}
	}
}

enterState( idleState );
trace("Starting V3.1");
