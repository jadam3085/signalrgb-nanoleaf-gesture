// Nanoleaf Gesture -- a SignalRGB network add-on for Nanoleaf panels, with an optional
// "gesture overlay" that blends colours from a local HTTP feed over the SignalRGB canvas.
//
// Copyright (c) 2026 Jonathan Adam. Released under the MIT License (see LICENSE).
//
// Clean-room implementation: written from Nanoleaf's public OpenAPI documentation and
// SignalRGB's public plugin documentation plus MIT-licensed community add-ons for the
// network-service API shape. No code from SignalRGB's stock Nanoleaf add-on was used.
// See README.md -> "References".
//
// Shape of the add-on:
//   * DiscoveryService  -- runs in SignalRGB's service context: finds controllers over
//                          mDNS (_nanoleafapi._tcp) or a typed IP, pairs, keeps the token.
//   * Initialize/Render/Shutdown -- run once per linked controller (`controller` global):
//                          build the canvas map, enable extControl v2, stream UDP frames.
//   * GestureFeed       -- polls the gesture URL; Render blends its frame over the canvas.
// ONE SENDER: udp.send is only ever called from Render (PanelStream.render).

export function Name() { return "Nanoleaf Gesture"; }
export function Version() { return "1.0.2"; }
export function Type() { return "network"; }
export function Publisher() { return "Jonathan Adam"; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [120, 80]; }
export function DefaultScale() { return 8.0; }

/* global
controller:readonly
discovery:readonly
service:readonly
device:readonly
udp:readonly
XMLHttpRequest:readonly
gestureFeed:readonly
gestureUrl:readonly
smoothTransitions:readonly
turnOffOnShutdown:readonly
*/

export function ControllableParameters() {
	return [
		{property: "gestureFeed", group: "gesture", label: "Gesture overlay", description: "Blend frames from the gesture feed over the SignalRGB canvas while a gesture session is active.", type: "boolean", default: "true"},
		{property: "gestureUrl", group: "gesture", label: "Gesture feed URL", description: "HTTP endpoint returning {active, seq, mix, ttl_ms, panels:[[id,r,g,b],...]}.", type: "textfield", default: DEFAULT_GESTURE_URL},
		{property: "smoothTransitions", group: "lighting", label: "Smooth transitions", description: "Ask the panels to fade 100 ms between frames instead of switching instantly.", type: "boolean", default: "false"},
		{property: "turnOffOnShutdown", group: "lighting", label: "Turn panels off on shutdown", description: "Switch the panels off when SignalRGB stops streaming to them.", type: "boolean", default: "false"},
	];
}

// ---------------------------------------------------------------- constants

const API_PORT = 16021;                 // Nanoleaf OpenAPI (HTTP)
const STREAM_PORT = 60222;              // extControl v2 UDP port
const DEFAULT_GESTURE_URL = "http://127.0.0.1:8936/nanoleaf/frame";
const MDNS_SERVICE = "_nanoleafapi._tcp.local.";

const HTTP_TIMEOUT_MS = 3000;
const RETRY_MS = 5000;                  // layout fetch / extControl enable retry
const INFO_REFRESH_MS = 60000;          // discovery: re-read info for linked controllers

const GESTURE_TIMEOUT_MS = 400;         // abort a gesture poll after this long
const POLL_ACTIVE_MS = 1000 / 30;       // 30 Hz while the feed says active
const POLL_IDLE_MS = 250;               // 4 Hz idle
const POLL_BACKOFF_MS = 1000;           // 1 Hz after repeated failures
const BACKOFF_AFTER_FAILURES = 3;
const POLL_SLACK_MS = 4;                // Render runs every ~30 ms; don't lose a tick to jitter
const DEFAULT_TTL_MS = 500;
const MAX_TTL_MS = 5000;

// panelLayout shapeType values that are not light-emitting panels: Rhythm module (1),
// Shapes controller (12), Lines connector (16), controller cap (19), power connector (20).
const NON_LIGHT_SHAPES = new Set([1, 12, 16, 19, 20]);
const MAX_GRID = 100;                   // longest canvas side, in LED cells

const SETTINGS_CACHE_GROUP = "ipCache"; // service.saveSetting("ipCache", "cache", json)
const SETTINGS_CACHE_KEY = "cache";
const SETTINGS_TOKEN_KEY = "key";       // service.saveSetting(<controller id>, "key", token)

// ---------------------------------------------------------------- small helpers

function truthy(value) {
	return value === true || value === 1 || value === "true" || value === "1";
}

// User controls arrive as script globals named after ControllableParameters properties.
// Read them by direct reference (typeof-guarded) so a missing one never throws.
function currentSettings() {
	return {
		feed: typeof gestureFeed === "undefined" ? true : truthy(gestureFeed),
		url: typeof gestureUrl === "string" && gestureUrl.trim() ? gestureUrl.trim() : DEFAULT_GESTURE_URL,
		smooth: typeof smoothTransitions === "undefined" ? false : truthy(smoothTransitions),
		offOnShutdown: typeof turnOffOnShutdown === "undefined" ? false : truthy(turnOffOnShutdown),
	};
}

function clampByte(value) {
	const v = Math.round(Number(value));
	return v > 255 ? 255 : (v >= 0 ? v : 0);
}

function isIPv4(text) {
	return /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(String(text || "").trim());
}

function deviceLog(message) {
	try { device.log(message); } catch (e) { /* logging must never throw */ }
}

function serviceLog(message) {
	try { service.log(message); } catch (e) { /* logging must never throw */ }
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch (e) {
		return undefined;
	}
}

// Asynchronous HTTP via XMLHttpRequest. `done(status, text)` is called exactly once;
// status 0 means network error / timeout / exception. Returns {abort()} or null.
function httpRequest(method, url, body, timeoutMs, done) {
	let finished = false;
	const finish = function (status, text) {
		if (finished) { return; }
		finished = true;
		try { done(status, text); } catch (e) { /* callbacks must never escape */ }
	};
	let xhr;
	try {
		xhr = new XMLHttpRequest();
		xhr.open(method, url, true);
		try { xhr.timeout = timeoutMs; } catch (e) { /* optional */ }
		xhr.onreadystatechange = function () {
			if (xhr.readyState === 4) { finish(Number(xhr.status) || 0, xhr.responseText || ""); }
		};
		xhr.ontimeout = function () { finish(0, ""); };
		xhr.onerror = function () { finish(0, ""); };
		if (body !== undefined) {
			try { xhr.setRequestHeader("Content-Type", "application/json"); } catch (e) { /* optional */ }
			xhr.send(body);
		} else {
			xhr.send();
		}
	} catch (e) {
		finish(0, "");
		return null;
	}
	return {
		abort: function () {
			finished = true;
			try { xhr.abort(); } catch (e) { /* already gone */ }
		},
	};
}

// ---------------------------------------------------------------- layout -> canvas

// Light panels from a GET /api/v1/<token>/ response (or its panelLayout block).
function lightPanels(info) {
	const layout = info && (info.panelLayout || info);
	const positions = layout && layout.layout && layout.layout.positionData;
	const orientation = Number(layout && layout.globalOrientation && layout.globalOrientation.value) || 0;
	const panels = [];
	if (!Array.isArray(positions)) { return {panels, orientation}; }
	for (const p of positions) {
		if (!p || typeof p !== "object") { continue; }
		const id = Number(p.panelId);
		const x = Number(p.x);
		const y = Number(p.y);
		const shape = Number(p.shapeType);
		if (!(id > 0) || !Number.isFinite(x) || !Number.isFinite(y) || NON_LIGHT_SHAPES.has(shape)) { continue; }
		panels.push({id, x, y, shape});
	}
	return {panels, orientation};
}

// Map panels onto a SignalRGB LED grid, in the SAME sense as the engine's
// nanoleaf_fx.Layout (kept in lockstep so the engine's frame endpoint and SignalRGB's
// own effects -- e.g. Screen Ambience -- paint the same physical panel at the same
// canvas cell). Nanoleaf positionData is y-DOWN (screen style, as the Nanoleaf app
// draws it). Negating y to y-up and then rotating by globalOrientation (the
// pre-2026-09-26 fix here, and still the SDK/App's own convention) gets the WALL'S
// vertical axis right but silently mirrors horizontal, because reflecting an axis
// after rotating by theta is the same map as rotating by -theta after reflecting
// (F . R(theta) == R(-theta) . F), and negate-y-then-negate-x is a 180-degree
// rotation: mirror_x . R(theta) . negate_y == R(180 - theta). So instead of
// negate-y + rotate(theta) + mirror-x, this rotates the RAW (never negated)
// positionData directly by (180 - globalOrientation) -- the orientation-sense
// complement for y-down data -- which lands on the identical, already
// horizontally- and vertically-correct canvas with no separate mirror step. See
// nanoleaf_fx.Layout.__init__ (python engine) for the point-by-point proof; both
// must apply the same formula or the two renderers disagree panel-by-panel. The cell
// size is half the closest panel spacing so every panel owns a distinct cell, capped
// at MAX_GRID cells. Final y is negated once, at the very end, only to convert this
// canvas's "math" y-up into the y-DOWN pixel-grid convention device.setSize()/
// setControllableLeds() expect (top-left origin) -- NOT a second orientation flip.
function canvasMap(panels, orientationDeg) {
	if (!panels || !panels.length) { return {width: 1, height: 1, leds: []}; }
	const n = panels.length;
	let cx = 0;
	let cy = 0;
	for (const p of panels) { cx += p.x; cy += p.y; }
	cx /= n;
	cy /= n;
	const effDeg = 180 - (Number(orientationDeg) || 0);
	const th = effDeg * Math.PI / 180;
	const c = Math.cos(th);
	const s = Math.sin(th);
	const pts = panels.map(function (p) {
		const dx = p.x - cx;
		const dy = p.y - cy;               // raw positionData, never pre-negated
		return {id: p.id, x: dx * c - dy * s, y: -(dx * s + dy * c)};
	});
	let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
	for (const p of pts) {
		x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
		y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
	}
	let minDist = Infinity;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
			if (d > 1e-6 && d < minDist) { minDist = d; }
		}
	}
	const span = Math.max(x1 - x0, y1 - y0);
	let cell = Number.isFinite(minDist) ? minDist / 2 : 1;
	if (span / cell > MAX_GRID - 1) { cell = span / (MAX_GRID - 1); }
	if (!(cell > 0)) { cell = 1; }
	const leds = pts.map(function (p) {
		return {id: p.id, x: Math.round((p.x - x0) / cell), y: Math.round((p.y - y0) / cell)};
	});
	return {
		width: Math.round((x1 - x0) / cell) + 1,
		height: Math.round((y1 - y0) / cell) + 1,
		leds,
	};
}

// ---------------------------------------------------------------- extControl v2 frame

// Nanoleaf extControl v2 UDP frame: nPanels (uint16 big-endian), then per panel
// panelId (uint16 BE), R, G, B, W (uint8 each), transitionTime (uint16 BE, 100 ms units).
function encodeFrameV2(entries, transition) {
	const n = entries.length & 0xffff;
	const t = Math.max(0, Math.min(0xffff, Math.round(Number(transition) || 0)));
	const out = new Array(2 + 8 * n);
	out[0] = (n >> 8) & 0xff;
	out[1] = n & 0xff;
	for (let i = 0; i < n; i++) {
		const e = entries[i];
		const o = 2 + 8 * i;
		const id = Number(e[0]) & 0xffff;
		out[o] = (id >> 8) & 0xff;
		out[o + 1] = id & 0xff;
		out[o + 2] = clampByte(e[1]);
		out[o + 3] = clampByte(e[2]);
		out[o + 4] = clampByte(e[3]);
		out[o + 5] = clampByte(e[4] || 0);
		out[o + 6] = (t >> 8) & 0xff;
		out[o + 7] = t & 0xff;
	}
	return out;
}

function blend(base, top, mix) {
	return [
		clampByte(base[0] + (top[0] - base[0]) * mix),
		clampByte(base[1] + (top[1] - base[1]) * mix),
		clampByte(base[2] + (top[2] - base[2]) * mix),
	];
}

// ---------------------------------------------------------------- gesture feed

// Parse a feed response. Returns {active:false}, a validated active frame, or
// undefined for anything malformed (caller treats that as a failure -> passthrough).
function parseGestureFrame(text) {
	const obj = parseJson(text);
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) { return undefined; }
	if (obj.active !== true) { return {active: false}; }
	if (!Array.isArray(obj.panels)) { return undefined; }
	const panels = new Map();
	for (const entry of obj.panels) {
		if (!Array.isArray(entry) || entry.length < 4) { continue; }
		const id = Number(entry[0]);
		const rgb = [Number(entry[1]), Number(entry[2]), Number(entry[3])];
		if (!(id > 0) || !rgb.every(Number.isFinite)) { continue; }
		panels.set(id, rgb.map(clampByte));
	}
	const mixRaw = Number(obj.mix);
	const ttlRaw = Number(obj.ttl_ms);
	return {
		active: true,
		seq: Number.isFinite(Number(obj.seq)) ? Number(obj.seq) : null,
		mix: obj.mix === undefined || !Number.isFinite(mixRaw) ? 1 : Math.max(0, Math.min(1, mixRaw)),
		ttl: Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, MAX_TTL_MS) : DEFAULT_TTL_MS,
		panels,
	};
}

class GestureFeed {
	constructor(request) {
		this.request = request || httpRequest;
		this.inflight = null;
		this.reset();
	}

	reset() {
		if (this.inflight) { this.inflight.abort(); }
		this.inflight = null;
		this.ticket = null;
		this.inflightAt = 0;
		this.lastPollAt = -Infinity;
		this.failures = 0;
		this.lastActive = false;
		this.frame = null;
		this.polls = 0;
	}

	interval() {
		if (this.failures >= BACKOFF_AFTER_FAILURES) { return POLL_BACKOFF_MS; }
		return this.lastActive ? POLL_ACTIVE_MS : POLL_IDLE_MS;
	}

	// Called once per Render. Starts at most one request; aborts one older than 400 ms.
	tick(now, enabled, url) {
		if (!enabled || !/^https?:\/\//i.test(String(url || ""))) {
			if (this.inflight || this.frame || this.failures) { this.reset(); }
			return;
		}
		if (this.inflight) {
			if (now - this.inflightAt < GESTURE_TIMEOUT_MS) { return; }
			this.inflight.abort();
			this.inflight = null;
			this.ticket = null;
			this.fail();
		}
		if (now - this.lastPollAt < this.interval() - POLL_SLACK_MS) { return; }
		this.lastPollAt = now;
		this.inflightAt = now;
		this.polls++;
		const self = this;
		const ticket = {};
		let answered = false;
		this.ticket = ticket;
		const handle = this.request("GET", url, undefined, GESTURE_TIMEOUT_MS, function (status, text) {
			answered = true;
			if (self.ticket !== ticket) { return; }
			self.inflight = null;
			self.ticket = null;
			self.onResponse(status, text, Date.now());
		});
		if (!answered && this.ticket === ticket) { this.inflight = handle || null; }
	}

	onResponse(status, text, now) {
		if (status !== 200) { this.fail(); return; }
		const frame = parseGestureFrame(text);
		if (!frame) { this.fail(); return; }
		this.failures = 0;
		this.lastActive = frame.active;
		this.frame = frame.active ? Object.assign(frame, {receivedAt: now}) : null;
	}

	fail() {
		this.failures++;
		this.lastActive = false;
		this.frame = null;
	}

	// The frame to blend, or null for pure passthrough (inactive, stale or absent).
	overlay(now) {
		const f = this.frame;
		if (!f || !f.active) { return null; }
		if (now - f.receivedAt > f.ttl) { return null; }
		return f;
	}
}

// ---------------------------------------------------------------- per-device stream

class PanelStream {
	constructor(ctrl, request) {
		this.ctrl = ctrl || {};
		this.request = request || httpRequest;
		this.ip = this.ctrl.ip;
		this.port = Number(this.ctrl.port) || API_PORT;
		this.token = this.ctrl.token || "";
		this.map = null;
		this.layoutPending = false;
		this.layoutTriedAt = -Infinity;
		this.extReady = false;
		this.extPending = false;
		this.extTriedAt = -Infinity;
		this.framesSent = 0;
		this.lastSendErrorAt = -Infinity;
		this.feed = new GestureFeed(this.request);
	}

	apiUrl(path) {
		return `http://${this.ip}:${this.port}/api/v1/${this.token}${path}`;
	}

	start(now) {
		try { device.setName(this.ctrl.name || "Nanoleaf"); } catch (e) { /* cosmetic */ }
		try { device.addFeature("udp"); } catch (e) { /* older runtimes expose udp globally */ }
		if (this.ctrl.panels && this.ctrl.panels.length) {
			this.applyLayout(this.ctrl.panels, this.ctrl.orientation);
		} else {
			this.fetchLayout(now);
		}
	}

	applyLayout(panels, orientation) {
		const map = canvasMap(panels, orientation);
		if (!map.leds.length) { return; }
		this.map = map;
		try {
			device.setSize([map.width, map.height]);
			device.setControllableLeds(
				map.leds.map(function (l) { return `Panel ${l.id}`; }),
				map.leds.map(function (l) { return [l.x, l.y]; }));
		} catch (e) {
			deviceLog(`Nanoleaf Gesture: canvas setup failed: ${e}`);
		}
		deviceLog(`Nanoleaf Gesture: ${map.leds.length} panels on a ${map.width}x${map.height} canvas`);
	}

	fetchLayout(now) {
		if (this.layoutPending || !this.token || !this.ip) { return; }
		this.layoutPending = true;
		this.layoutTriedAt = now;
		const self = this;
		this.request("GET", this.apiUrl("/"), undefined, HTTP_TIMEOUT_MS, function (status, text) {
			self.layoutPending = false;
			const info = status === 200 ? parseJson(text) : undefined;
			const found = lightPanels(info);
			if (!found.panels.length) {
				deviceLog(`Nanoleaf Gesture: layout read failed (HTTP ${status})`);
				return;
			}
			self.ctrl.panels = found.panels;
			self.ctrl.orientation = found.orientation;
			self.applyLayout(found.panels, found.orientation);
		});
	}

	enableExtControl(now) {
		if (this.extReady || this.extPending || now - this.extTriedAt < RETRY_MS) { return; }
		this.extPending = true;
		this.extTriedAt = now;
		const self = this;
		const body = JSON.stringify({write: {command: "display", animType: "extControl", extControlVersion: "v2"}});
		this.request("PUT", this.apiUrl("/effects"), body, HTTP_TIMEOUT_MS, function (status) {
			self.extPending = false;
			self.extReady = status === 200 || status === 204;
			deviceLog(self.extReady
				? "Nanoleaf Gesture: extControl v2 streaming enabled"
				: `Nanoleaf Gesture: extControl enable failed (HTTP ${status}), retrying`);
		});
	}

	render(now) {
		if (!this.token || !this.ip) { return; }
		if (!this.map) {
			if (now - this.layoutTriedAt >= RETRY_MS) { this.fetchLayout(now); }
			return;
		}
		this.enableExtControl(now);
		if (!this.extReady) { return; }

		const settings = currentSettings();
		this.feed.tick(now, settings.feed, settings.url);
		const overlay = this.feed.overlay(now);

		const entries = new Array(this.map.leds.length);
		for (let i = 0; i < this.map.leds.length; i++) {
			const led = this.map.leds[i];
			let rgb = device.color(led.x, led.y) || [0, 0, 0];
			if (overlay) {
				const top = overlay.panels.get(led.id);
				if (top) { rgb = blend(rgb, top, overlay.mix); }
			}
			entries[i] = [led.id, rgb[0], rgb[1], rgb[2], 0];
		}
		const packet = encodeFrameV2(entries, settings.smooth ? 1 : 0);
		try {
			udp.send(this.ip, STREAM_PORT, packet);
			this.framesSent++;
		} catch (e) {
			if (now - this.lastSendErrorAt > 5000) {
				this.lastSendErrorAt = now;
				deviceLog(`Nanoleaf Gesture: UDP send failed: ${e}`);
			}
		}
	}

	stop() {
		this.feed.reset();
		if (currentSettings().offOnShutdown && this.token && this.ip) {
			this.request("PUT", this.apiUrl("/state"), JSON.stringify({on: {value: false}}), HTTP_TIMEOUT_MS, function () {});
		}
		this.extReady = false;
	}
}

let stream = null;

export function Initialize() {
	try {
		stream = new PanelStream(controller);
		stream.start(Date.now());
	} catch (e) {
		deviceLog(`Nanoleaf Gesture: Initialize failed: ${e}`);
	}
}

export function Render() {
	if (!stream) { return; }
	try {
		stream.render(Date.now());
	} catch (e) {
		deviceLog(`Nanoleaf Gesture: Render error: ${e}`);
	}
}

export function Shutdown() {
	if (!stream) { return; }
	try { stream.stop(); } catch (e) { /* shutting down anyway */ }
}

export function ongestureFeedChanged() {
	if (stream) { stream.feed.reset(); }
}

export function ongestureUrlChanged() {
	if (stream) { stream.feed.reset(); }
}

// ---------------------------------------------------------------- discovery service

// Controller cache persisted as JSON: [[id, {hostname, name, port, firmwareVersion, model, id, ip}], ...]
class ControllerCache {
	constructor() {
		this.entries = new Map();
		const raw = this.read();
		if (!raw) { return; }
		const parsed = parseJson(raw);
		const pairs = Array.isArray(parsed) ? parsed
			: (parsed && typeof parsed === "object" ? Object.keys(parsed).map(function (k) { return [k, parsed[k]]; }) : []);
		for (const pair of pairs) {
			if (Array.isArray(pair) && pair.length >= 2 && pair[1] && typeof pair[1] === "object" && isIPv4(pair[1].ip)) {
				this.entries.set(String(pair[0]), pair[1]);
			}
		}
	}

	read() {
		try { return service.getSetting(SETTINGS_CACHE_GROUP, SETTINGS_CACHE_KEY); } catch (e) { return undefined; }
	}

	put(ctrl) {
		this.entries.set(ctrl.id, {
			hostname: ctrl.hostname || ctrl.name,
			name: ctrl.name,
			port: ctrl.port,
			firmwareVersion: ctrl.firmwareVersion || "",
			model: ctrl.model || "",
			id: ctrl.id,
			ip: ctrl.ip,
		});
		this.persist();
	}

	remove(id) {
		if (this.entries.delete(id)) { this.persist(); }
	}

	idForIp(ip) {
		for (const [id, v] of this.entries) {
			if (v.ip === ip) { return id; }
		}
		return undefined;
	}

	persist() {
		try {
			service.saveSetting(SETTINGS_CACHE_GROUP, SETTINGS_CACHE_KEY, JSON.stringify(Array.from(this.entries.entries())));
		} catch (e) {
			serviceLog(`Nanoleaf Gesture: could not save the controller cache: ${e}`);
		}
	}
}

class NanoleafController {
	constructor(value) {
		this.id = value.id;
		this.ip = value.ip;
		this.port = Number(value.port) || API_PORT;
		this.hostname = value.hostname || "";
		this.name = value.name || value.hostname || `Nanoleaf ${value.ip}`;
		this.model = value.model || "";
		this.firmwareVersion = value.firmwareVersion || "";
		this.token = "";
		this.paired = false;
		this.busy = false;
		this.statusText = "Not linked";
		this.panels = [];
		this.orientation = 0;
	}
}

export function DiscoveryService() {
	this.IconUrl = "";
	this.MDns = [MDNS_SERVICE];
	this.request = httpRequest;          // replaceable in tests
	this.cache = null;
	this.announced = new Set();
	this.started = false;
	this.lastRefresh = 0;

	this.Initialize = function () {
		serviceLog("Nanoleaf Gesture: discovery started (mDNS _nanoleafapi._tcp, or add an IP manually)");
	};

	this.Update = function () {
		if (!this.started) {
			this.started = true;
			this.cache = new ControllerCache();
			for (const entry of Array.from(this.cache.entries.values())) {
				this.upsert(entry);
			}
			this.lastRefresh = Date.now();
			return;
		}
		if (Date.now() - this.lastRefresh >= INFO_REFRESH_MS) {
			this.lastRefresh = Date.now();
			for (const ctrl of this.known()) {
				if (ctrl.token && !ctrl.busy) { this.refreshInfo(ctrl); }
			}
		}
	};

	// mDNS results: [{ip, port, txt: {id, md, srcvers}, hostname?, name?}, ...]
	this.connect = function (devices) {
		for (const dev of devices || []) {
			if (!dev || typeof dev !== "object") { continue; }
			const txt = dev.txt && typeof dev.txt === "object" ? dev.txt : {};
			const ip = dev.ip || dev.address;
			if (!isIPv4(ip)) { continue; }
			this.upsert({
				id: String(txt.id || dev.id || this.ensureCache().idForIp(ip) || `ip-${ip}`),
				ip,
				port: Number(dev.port) || API_PORT,
				hostname: dev.hostname || dev.name || "",
				name: dev.name || dev.hostname || "",
				model: txt.md || "",
				firmwareVersion: txt.srcvers || "",
			});
		}
	};

	this.forceDiscover = function (ipAddress) {
		const ip = String(ipAddress || "").trim();
		if (!isIPv4(ip)) {
			serviceLog(`Nanoleaf Gesture: ignoring invalid IPv4 address "${ip}"`);
			return;
		}
		this.upsert({id: this.ensureCache().idForIp(ip) || `ip-${ip}`, ip, port: API_PORT, name: `Nanoleaf ${ip}`});
	};
	this.checkIP = this.forceDiscover;

	this.removedDevices = function (id) {
		const ctrl = this.lookup(id);
		if (ctrl) {
			try { service.removeController(ctrl); } catch (e) { /* already gone */ }
		}
		this.announced.delete(id);
	};

	// QML "Link": POST /api/v1/new while the controller is in pairing mode.
	this.link = function (ref) {
		const ctrl = ref && this.lookup(ref.id);
		if (!ctrl || ctrl.busy) { return; }
		ctrl.busy = true;
		ctrl.statusText = "Pairing...";
		this.touch(ctrl);
		const self = this;
		this.request("POST", `http://${ctrl.ip}:${ctrl.port}/api/v1/new`, "", HTTP_TIMEOUT_MS, function (status, text) {
			ctrl.busy = false;
			const body = status === 200 ? parseJson(text) : undefined;
			const token = body && typeof body.auth_token === "string" ? body.auth_token : "";
			if (token) {
				ctrl.token = token;
				try { service.saveSetting(ctrl.id, SETTINGS_TOKEN_KEY, token); } catch (e) { serviceLog(`Nanoleaf Gesture: could not save token: ${e}`); }
				self.refreshInfo(ctrl);
				return;
			}
			ctrl.statusText = status === 403
				? "Not in pairing mode: hold the controller's power button 5-7 s, then Link"
				: `Pairing failed (HTTP ${status || "no response"})`;
			self.touch(ctrl);
		});
	};

	this.unlink = function (ref) {
		const ctrl = ref && this.lookup(ref.id);
		if (!ctrl) { return; }
		ctrl.token = "";
		ctrl.paired = false;
		ctrl.statusText = "Not linked";
		try {
			if (typeof service.removeSetting === "function") { service.removeSetting(ctrl.id, SETTINGS_TOKEN_KEY); }
			else { service.saveSetting(ctrl.id, SETTINGS_TOKEN_KEY, ""); }
		} catch (e) { /* best effort */ }
		try { service.suppressController(ctrl); } catch (e) { /* optional API */ }
		this.announced.delete(ctrl.id);
		this.touch(ctrl);
	};

	this.remove = function (ref) {
		const ctrl = ref && this.lookup(ref.id);
		if (ctrl) { this.unlink(ctrl); }
		if (ref) {
			this.removedDevices(ref.id);
			this.ensureCache().remove(ref.id);
		}
	};

	// ---- internals

	this.ensureCache = function () {
		if (!this.cache) { this.cache = new ControllerCache(); }
		return this.cache;
	};

	this.lookup = function (id) {
		try { return service.getController(id); } catch (e) { return undefined; }
	};

	this.known = function () {
		try {
			return (service.controllers || []).map(function (c) { return c && c.obj ? c.obj : c; }).filter(Boolean);
		} catch (e) {
			return [];
		}
	};

	this.touch = function (ctrl) {
		try { service.updateController(ctrl); } catch (e) { /* UI refresh only */ }
	};

	this.upsert = function (value) {
		if (!value || !value.id || !isIPv4(value.ip)) { return undefined; }
		let ctrl = this.lookup(value.id);
		if (!ctrl) {
			ctrl = new NanoleafController(value);
			let token = "";
			try { token = service.getSetting(ctrl.id, SETTINGS_TOKEN_KEY) || ""; } catch (e) { token = ""; }
			ctrl.token = typeof token === "string" ? token : "";
			ctrl.statusText = ctrl.token ? "Connecting..." : "Not linked: put the controller in pairing mode, then Link";
			try { service.addController(ctrl); } catch (e) { serviceLog(`Nanoleaf Gesture: addController failed: ${e}`); }
		} else {
			const ipChanged = ctrl.ip !== value.ip;
			ctrl.ip = value.ip;
			ctrl.port = Number(value.port) || ctrl.port || API_PORT;
			if (value.name && !ctrl.paired) { ctrl.name = value.name; }
			if (value.hostname) { ctrl.hostname = value.hostname; }
			if (value.model) { ctrl.model = value.model; }
			if (value.firmwareVersion) { ctrl.firmwareVersion = value.firmwareVersion; }
			if (!ipChanged && ctrl.paired) { this.touch(ctrl); return ctrl; }
		}
		this.ensureCache().put(ctrl);
		this.touch(ctrl);
		if (ctrl.token && !ctrl.busy) { this.refreshInfo(ctrl); }
		return ctrl;
	};

	// GET /api/v1/<token>/: name, model, firmware and panel layout; announce when good.
	this.refreshInfo = function (ctrl) {
		if (!ctrl.token || ctrl.busy) { return; }
		ctrl.busy = true;
		const self = this;
		this.request("GET", `http://${ctrl.ip}:${ctrl.port}/api/v1/${ctrl.token}/`, undefined, HTTP_TIMEOUT_MS, function (status, text) {
			ctrl.busy = false;
			const info = status === 200 ? parseJson(text) : undefined;
			if (!info || typeof info !== "object") {
				if (status === 401 || status === 403) {
					ctrl.paired = false;
					ctrl.statusText = "Token rejected: Link again";
				} else {
					ctrl.statusText = `Unreachable (HTTP ${status || "no response"})`;
				}
				self.touch(ctrl);
				return;
			}
			const found = lightPanels(info);
			ctrl.name = info.name || ctrl.name;
			ctrl.model = info.model || ctrl.model;
			ctrl.firmwareVersion = info.firmwareVersion || ctrl.firmwareVersion;
			ctrl.panels = found.panels;
			ctrl.orientation = found.orientation;
			ctrl.paired = true;
			ctrl.statusText = `Linked: ${found.panels.length} panels`;
			self.ensureCache().put(ctrl);
			self.touch(ctrl);
			if (!self.announced.has(ctrl.id)) {
				self.announced.add(ctrl.id);
				try { service.announceController(ctrl); } catch (e) { serviceLog(`Nanoleaf Gesture: announce failed: ${e}`); }
			}
		});
	};
}
