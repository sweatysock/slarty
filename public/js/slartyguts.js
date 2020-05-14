

// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {
	console.log('socket connected!');
	socketConnected = true;
	socketIO.emit("superHi"); 	// Say hi to the server so it adds us to its list of supervisors

	socketIO.on('s', function (data) { 
		document.getElementById("idle").innerHTML = data["idle"]
		document.getElementById("upstream").innerHTML = data["upstream"]
		document.getElementById("downstream").innerHTML = data["downstream"]
		document.getElementById("genMix").innerHTML = data["genMix"]
		document.getElementById("clients").innerHTML = data["clients"]
		document.getElementById("active").innerHTML = data["active"]
		document.getElementById("in").innerHTML = data["in"]
		document.getElementById("out").innerHTML = data["out"]
		document.getElementById("overflows").innerHTML = data["overflows"]
		document.getElementById("shortages").innerHTML = data["shortages"]
		document.getElementById("forcedMixes").innerHTML = data["forcedMixes"]
		document.getElementById("threads").innerHTML = data["threads"]
		document.getElementById("cbs").innerHTML = data["cbs"]
		document.getElementById("pacClass").innerHTML = data["pacClass"]
	});
});

socketIO.on('disconnect', function () {
	console.log('socket disconnected!');
	socketConnected = false;
});


