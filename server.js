const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");
const dotenv = require("dotenv");

dotenv.config();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const CHANNEL = (process.env.TWITCH_CHANNEL || "")
	.replace(/^https?:\/\/www\.twitch\.tv\//i, "")
	.replace(/^#/, "")
	.replace(/\/$/, "")
	.toLowerCase();
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TOKEN_FILE = path.join(__dirname, "twitch-token.json");
const TWITCH_API = "https://id.twitch.tv/oauth2";
const TWITCH_SCOPES = "chat:read";
const projectRoot = __dirname;
const browserClients = new Set();
const browserSocketServer = new WebSocketServer({ noServer: true });
let twitchSocket;
let twitchReconnectTimer;
let twitchReconnectDelay = 1000;
let twitchAuthPromise;
let twitchToken;
let twitchUsername;
let shuttingDown = false;

const MIME_TYPES = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
};

function sendToTwitch(message) {
	if (twitchSocket && twitchSocket.readyState === WebSocket.OPEN) {
		twitchSocket.send(`${message}\r\n`);
	}
}

async function twitchRequest(endpoint, body) {
	const response = await fetch(`${TWITCH_API}/${endpoint}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	const data = await response.json();

	if (!response.ok) {
		const error = new Error(data.message || data.error || `Twitch request failed (${response.status})`);
		error.code = data.error || data.message;
		throw error;
	}

	return data;
}

function readStoredToken() {
	try {
		return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") {
			console.warn("Unable to read the saved Twitch authorization; a new authorization is required.");
		}
		return undefined;
	}
}

function saveStoredToken(token) {
	fs.writeFileSync(TOKEN_FILE, `${JSON.stringify(token, null, "\t")}\n`, { mode: 0o600 });
}

async function validateToken(accessToken) {
	const response = await fetch(`${TWITCH_API}/validate`, {
		headers: { Authorization: `OAuth ${accessToken}` },
	});
	if (!response.ok) {
		return undefined;
	}
	return response.json();
}

async function refreshToken(refreshTokenValue) {
	const token = await twitchRequest("token", {
		client_id: CLIENT_ID,
		grant_type: "refresh_token",
		refresh_token: refreshTokenValue,
	});
	return {
		access_token: token.access_token,
		refresh_token: token.refresh_token || refreshTokenValue,
	};
}

async function requestDeviceToken() {
	const device = await twitchRequest("device", {
		client_id: CLIENT_ID,
		scopes: TWITCH_SCOPES,
	});
	console.log(`Authorize this server at ${device.verification_uri}`);
	console.log(`Enter code: ${device.user_code}`);

	let interval = Math.max(device.interval || 5, 1) * 1000;
	while (!shuttingDown) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		try {
			const token = await twitchRequest("token", {
				client_id: CLIENT_ID,
				device_code: device.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			});
			return {
				access_token: token.access_token,
				refresh_token: token.refresh_token,
			};
		} catch (error) {
			if (error.code === "authorization_pending") {
				continue;
			}
			if (error.code === "slow_down") {
				interval += 5000;
				continue;
			}
			throw error;
		}
	}
	throw new Error("Twitch authorization cancelled during shutdown.");
}

async function ensureTwitchToken(forceAuthorization = false) {
	if (!CLIENT_ID) {
		throw new Error("Set TWITCH_CLIENT_ID in .env to enable Twitch authorization.");
	}
	if (!forceAuthorization && twitchToken?.access_token) {
		const validation = await validateToken(twitchToken.access_token);
		if (validation) {
			twitchUsername = validation.login.toLowerCase();
			return twitchToken;
		}
	}

	const storedToken = forceAuthorization ? undefined : readStoredToken();
	if (!forceAuthorization && storedToken?.refresh_token) {
		try {
			twitchToken = await refreshToken(storedToken.refresh_token);
		} catch (error) {
			console.warn("Saved Twitch authorization expired; authorization is required again.");
		}
	}
	if (!twitchToken) {
		twitchToken = await requestDeviceToken();
	}

	const validation = await validateToken(twitchToken.access_token);
	if (!validation) {
		twitchToken = undefined;
		throw new Error("Twitch returned an invalid access token.");
	}
	twitchUsername = validation.login.toLowerCase();
	saveStoredToken(twitchToken);
	return twitchToken;
}

function startTwitchAuthorization(forceAuthorization = false) {
	if (!twitchAuthPromise) {
		twitchAuthPromise = ensureTwitchToken(forceAuthorization)
			.then(() => {
				if (!shuttingDown) {
					connectToTwitch();
				}
			})
			.catch((error) => {
				console.error(`Twitch authorization failed: ${error.message}`);
			})
			.finally(() => {
				twitchAuthPromise = undefined;
			});
	}
	return twitchAuthPromise;
}

function broadcastChestEvent() {
	const event = JSON.stringify({ type: "chest" });

	for (const client of browserClients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(event);
		}
	}
}

function handleTwitchLine(line) {
	if (line.startsWith("PING ")) {
		sendToTwitch(`PONG ${line.slice(5)}`);
		return;
	}
	if (/^:\S+ 001 \S+ /.test(line)) {
		return;
	}
	if (line.includes(" NOTICE ") && /login authentication failed|improperly formatted auth/i.test(line)) {
		twitchToken = undefined;
		startTwitchAuthorization(true);
		return;
	}

	const messageMatch = line.match(/^:([^!]+)!\S+ PRIVMSG #([^ ]+) :([\s\S]*)$/);
	if (!messageMatch || messageMatch[2].toLowerCase() !== CHANNEL) {
		return;
	}

	const command = messageMatch[3].trim().toLowerCase().split(/\s+/, 1)[0];
	if (command === "!chest") {
		broadcastChestEvent();
	}
}

function scheduleTwitchReconnect() {
	if (twitchReconnectTimer || !CHANNEL || shuttingDown) {
		return;
	}

	twitchReconnectTimer = setTimeout(() => {
		twitchReconnectTimer = undefined;
		startTwitchAuthorization();
	}, twitchReconnectDelay);
	twitchReconnectDelay = Math.min(twitchReconnectDelay * 2, 30000);
}

function connectToTwitch() {
	if (!twitchToken?.access_token || !CHANNEL) {
		if (!CHANNEL) {
			console.warn("Twitch IRC disabled: set TWITCH_CHANNEL to enable it.");
		}
		return;
	}

	twitchSocket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

	twitchSocket.on("open", () => {
		twitchReconnectDelay = 1000;
		sendToTwitch(`PASS oauth:${twitchToken.access_token}`);
		sendToTwitch(`NICK ${twitchUsername}`);
		sendToTwitch(`JOIN #${CHANNEL}`);
	});
	twitchSocket.on("message", (data) => {
		for (const line of data.toString().split(/\r?\n/)) {
			if (line) {
				handleTwitchLine(line);
			}
		}
	});
	twitchSocket.on("error", (error) => console.error("Twitch IRC error:", error.message));
	twitchSocket.on("close", () => {
		scheduleTwitchReconnect();
	});
}

function serveStaticFile(request, response) {
	const requestPath = decodeURIComponent(request.url.split("?", 1)[0]);
	const relativePath = requestPath === "/" ? "HTML/AnimationTest.html" : requestPath.slice(1);
	const filePath = path.resolve(projectRoot, relativePath);

	if (!filePath.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(filePath)) {
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Not found");
		return;
	}

	const extension = path.extname(filePath).toLowerCase();
	response.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream" });
	fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
	if (request.method !== "GET") {
		response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Method not allowed");
		return;
	}

	serveStaticFile(request, response);
});

server.on("upgrade", (request, socket, head) => {
	const requestUrl = new URL(request.url, `http://${request.headers.host}`);
	if (requestUrl.pathname !== "/events") {
		socket.destroy();
		return;
	}

	browserSocketServer.handleUpgrade(request, socket, head, (client) => {
		browserSocketServer.emit("connection", client, request);
	});
});

browserSocketServer.on("connection", (client) => {
	browserClients.add(client);
	client.on("close", () => browserClients.delete(client));
	client.on("error", () => browserClients.delete(client));
});

server.listen(PORT, () => {
	startTwitchAuthorization();
});

function shutdown() {
	shuttingDown = true;
	clearTimeout(twitchReconnectTimer);
	if (twitchSocket) {
		twitchSocket.removeAllListeners("close");
		twitchSocket.close();
	}
	server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
