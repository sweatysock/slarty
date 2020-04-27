// Code for the Audio Context real time thread
//
var counter=0;

class AudenceProcessor extends AudioWorkletProcessor {
	static get parameterDescriptors() {
	      return [{
	            name: 'size',
	            defaultValue: 1024,
	            minValue: 128,
	            maxValue: 16384,
		}];
	}

	constructor(options) {
		super(options);
		this.micBuffer = []; 			// Mic audio accumulates here until enough to send
		this.sendBuffer = []; 			// Mic audio to send is moved into here and sent to main.js
		this.receiveBuffer = []; 		// Multiple client buffers to store audio from server
		this.pointer = 0;			// Place to start reading receiveBuffer[0] from 
		this.maxBufferSize = 5; 		// The most buffers we will keep before removing old audio
		this.port.onmessage = (e) => { 		// Server has sent audio for a client
			var voiceData = e.data.audio;
			var receiveBuffer = this.receiveBuffer;
			var maxBufferSize = this.maxBufferSize;
			receiveBuffer.push( voiceData );
			// If the buffer has backlogged too much audio remove oldest audio down to maxBufferSize
			if (receiveBuffer.length > maxBufferSize) {
//				console.log("BUFFER OVERFLOW. Removing oldest audio");
				receiveBuffer.shift();
			}
		}
	}

	process (inputs, outputs, parameters) {
		// There are two tasks here: 1. buffer mic audio & 2. output buffered server audio
		// 1. Buffer and send Mic audio. 
		const input = inputs[0][0];			// Single input from Mic
		const chunkSize = parameters.size;		// data amount needed to send
		let micBuffer = this.micBuffer;
		let sendBuffer = this.sendBuffer;
		if (input.length > 0) {
			for (let i=0; i<input.length; i++)	// Buffer audio up
				micBuffer.push(input[i]);
			if (micBuffer.length >= chunkSize) {	// enough audio to send?
				sendBuffer = micBuffer.splice(0, chunkSize);
				this.port.postMessage({ 	// send a chunk to main thread
					"audio": sendBuffer,
				});                   
			}
		}
		// 2. Output audio. 
		const outputL = outputs[0][0];			// left channel output
		const outputR = outputs[0][1];			// right channel output
		let framesToOutput = input.length;		// send as much audio as we receive
		let receiveBuffer = this.receiveBuffer;		
		let buffer = [];				// output audio buffer
		// take audio from oldest receiveBuffer. If empty shift to next and continue until enough
		if (receiveBuffer[0] != undefined)		//If no audio leave output blank
			for (let i=0; i < framesToOutput; i++) {
				if (this.pointer < receiveBuffer[0].length) {
					outputL[i] = receiveBuffer[0][this.pointer];
					this.pointer++;
				}
				else {
					receiveBuffer.shift();
					this.pointer = 0;
					if (receiveBuffer[0] == undefined) {
						break;		// Out of audio so leave rest blank
					}
					else {
						outputL[i] = receiveBuffer[0][this.pointer];
						this.pointer++;
					}
				}
				outputR[i] = outputL[i];
			}
		return true;
	}

};

registerProcessor('audence-processor', AudenceProcessor);
