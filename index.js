import EventEmitter from "events";
import once from "once";
import Peer from "simple-peer";
import Socket from "simple-websocket";
import {
  hex2bin,
  text2arr,
  arr2text,
  bin2hex,
  randomBytes,
} from "uint8-util/browser";
import { arr2hex, hex2arr } from "uint8-util/util";
const DESTROY_TIMEOUT = 1000;
const RECONNECT_MINIMUM = 10 * 1000;
const RECONNECT_MAXIMUM = 60 * 60 * 1000;
const RECONNECT_VARIANCE = 5 * 60 * 1000;
const OFFER_TIMEOUT = 50 * 1000;
const DEFAULT_ANNOUNCE_PEERS = 50;
const DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000;
const socketPool = {};
class Tracker extends EventEmitter {
  constructor(client, announceUrl) {
    super();
    this.client = client;
    this.announceUrl = announceUrl;
    this.interval = null;
    this.destroyed = false;
  }
  setInterval(intervalMs) {
    if (intervalMs == null) intervalMs = DEFAULT_ANNOUNCE_INTERVAL;
    clearInterval(this.interval);
    if (intervalMs) {
      this.interval = setInterval(() => {
        this.announce(this.client._defaultAnnounceOpts());
      }, intervalMs);
      if (this.interval.unref) this.interval.unref();
    }
  }
}
class WebSocketTracker extends Tracker {
  constructor(client, announceUrl) {
    super(client, announceUrl);
    this.peers = {};
    this.socket = null;
    this.reconnecting = false;
    this.retries = 0;
    this.reconnectTimer = null;
    this.expectingResponse = false;
    this._openSocket();
  }
  announce(opts) {
    if (this.destroyed || this.reconnecting) return;
    if (!this.socket.connected) {
      this.socket.once("connect", () => {
        this.announce(opts);
      });
      return;
    }
    const params = Object.assign({}, opts, {
      action: "announce",
      info_hash: this.client._infoHashBinary,
      peer_id: this.client._peerIdBinary,
    });
    if (this._trackerId) params.trackerid = this._trackerId;
    if (opts.event === "stopped" || opts.event === "completed") {
      this._send(params);
    } else {
      const numwant = Math.min(opts.numwant, 5);
      this._generateOffers(numwant, (offers) => {
        params.numwant = numwant;
        params.offers = offers;
        this._send(params);
      });
    }
  }
  scrape(opts) {
    if (this.destroyed || this.reconnecting) return;
    if (!this.socket.connected) {
      this.socket.once("connect", () => {
        this.scrape(opts);
      });
      return;
    }
    const infoHashes =
      Array.isArray(opts.infoHash) && opts.infoHash.length > 0
        ? opts.infoHash.map((infoHash) => hex2bin(infoHash))
        : (opts.infoHash && hex2bin(opts.infoHash)) ||
          this.client._infoHashBinary;
    const params = { action: "scrape", info_hash: infoHashes };
    this._send(params);
  }
  destroy(cb = () => {}) {
    if (this.destroyed) return cb(null);
    this.destroyed = true;
    clearInterval(this.interval);
    clearTimeout(this.reconnectTimer);
    for (const peerId in this.peers) {
      const peer = this.peers[peerId];
      clearTimeout(peer.trackerTimeout);
      peer.destroy();
    }
    this.peers = null;
    if (this.socket) {
      this.socket.removeListener("connect", this._onSocketConnectBound);
      this.socket.removeListener("data", this._onSocketDataBound);
      this.socket.removeListener("close", this._onSocketCloseBound);
      this.socket.removeListener("error", this._onSocketErrorBound);
      this.socket = null;
    }
    this._onSocketConnectBound = null;
    this._onSocketErrorBound = null;
    this._onSocketDataBound = null;
    this._onSocketCloseBound = null;
    if (socketPool[this.announceUrl]) {
      socketPool[this.announceUrl].consumers -= 1;
    }
    if (socketPool[this.announceUrl].consumers > 0) return cb();
    let socket = socketPool[this.announceUrl];
    delete socketPool[this.announceUrl];
    socket.on("error", () => {});
    socket.once("close", cb);
    let timeout;
    if (!this.expectingResponse) return destroyCleanup();
    timeout = setTimeout(destroyCleanup, DESTROY_TIMEOUT);
    socket.once("data", destroyCleanup);
    function destroyCleanup() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      socket.removeListener("data", destroyCleanup);
      socket.destroy();
      socket = null;
    }
  }
  _openSocket() {
    this.destroyed = false;
    if (!this.peers) this.peers = {};
    this._onSocketConnectBound = () => {
      this._onSocketConnect();
    };
    this._onSocketErrorBound = (err) => {
      this._onSocketError(err);
    };
    this._onSocketDataBound = (data) => {
      this._onSocketData(data);
    };
    this._onSocketCloseBound = () => {
      this._onSocketClose();
    };
    this.socket = socketPool[this.announceUrl];
    if (this.socket) {
      socketPool[this.announceUrl].consumers += 1;
      if (this.socket.connected) {
        this._onSocketConnectBound();
      }
    } else {
      let agent;
      this.socket = socketPool[this.announceUrl] = new Socket({
        url: this.announceUrl,
        agent,
      });
      this.socket.consumers = 1;
      this.socket.once("connect", this._onSocketConnectBound);
    }
    this.socket.on("data", this._onSocketDataBound);
    this.socket.once("close", this._onSocketCloseBound);
    this.socket.once("error", this._onSocketErrorBound);
  }
  _onSocketConnect() {
    if (this.destroyed) return;
    if (this.reconnecting) {
      this.reconnecting = false;
      this.retries = 0;
      this.announce(this.client._defaultAnnounceOpts());
    }
  }
  _onSocketData(data) {
    if (this.destroyed) return;
    this.expectingResponse = false;
    try {
      data = JSON.parse(arr2text(data));
    } catch (err) {
      this.client.emit("warning", new Error("Invalid tracker response"));
      return;
    }
    if (data.action === "announce") {
      this._onAnnounceResponse(data);
    } else if (data.action === "scrape") {
      this._onScrapeResponse(data);
    } else {
      this._onSocketError(
        new Error(`invalid action in WS response: ${data.action}`)
      );
    }
  }
  _onAnnounceResponse(data) {
    if (data.info_hash !== this.client._infoHashBinary) {
      return;
    }
    if (data.peer_id && data.peer_id === this.client._peerIdBinary) {
      return;
    }
    const failure = data["failure reason"];
    if (failure) return this.client.emit("warning", new Error(failure));
    const warning = data["warning message"];
    if (warning) this.client.emit("warning", new Error(warning));
    const interval = data.interval || data["min interval"];
    if (interval) this.setInterval(interval * 1000);
    const trackerId = data["tracker id"];
    if (trackerId) {
      this._trackerId = trackerId;
    }
    if (data.complete != null) {
      const response = Object.assign({}, data, {
        announce: this.announceUrl,
        infoHash: bin2hex(data.info_hash),
      });
      this.client.emit("update", response);
    }
    let peer;
    if (data.offer && data.peer_id) {
      peer = this._createPeer();
      peer.id = bin2hex(data.peer_id);
      peer.once("signal", (answer) => {
        const params = {
          action: "announce",
          info_hash: this.client._infoHashBinary,
          peer_id: this.client._peerIdBinary,
          to_peer_id: data.peer_id,
          answer,
          offer_id: data.offer_id,
        };
        if (this._trackerId) params.trackerid = this._trackerId;
        this._send(params);
      });
      this.client.emit("peer", peer);
      peer.signal(data.offer);
    }
    if (data.answer && data.peer_id) {
      const offerId = bin2hex(data.offer_id);
      peer = this.peers[offerId];
      if (peer) {
        peer.id = bin2hex(data.peer_id);
        this.client.emit("peer", peer);
        peer.signal(data.answer);
        clearTimeout(peer.trackerTimeout);
        peer.trackerTimeout = null;
        delete this.peers[offerId];
      }
    }
  }
  _onScrapeResponse(data) {
    data = data.files || {};
    const keys = Object.keys(data);
    if (keys.length === 0) {
      this.client.emit("warning", new Error("invalid scrape response"));
      return;
    }
    keys.forEach((infoHash) => {
      const response = Object.assign(data[infoHash], {
        announce: this.announceUrl,
        infoHash: bin2hex(infoHash),
      });
      this.client.emit("scrape", response);
    });
  }
  _onSocketClose() {
    if (this.destroyed) return;
    this.destroy();
    this._startReconnectTimer();
  }
  _onSocketError(err) {
    if (this.destroyed) return;
    this.destroy();
    this.client.emit("warning", err);
    this._startReconnectTimer();
  }
  _startReconnectTimer() {
    const ms =
      Math.floor(Math.random() * RECONNECT_VARIANCE) +
      Math.min(
        Math.pow(2, this.retries) * RECONNECT_MINIMUM,
        RECONNECT_MAXIMUM
      );
    this.reconnecting = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.retries++;
      this._openSocket();
    }, ms);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }
  _send(params) {
    if (this.destroyed) return;
    this.expectingResponse = true;
    const message = JSON.stringify(params);
    this.socket.send(message);
  }
  _generateOffers(numwant, cb) {
    const offers = [];
    const checkDone = () => {
      if (offers.length === numwant) {
        cb(offers);
      }
    };
    const generateOffer = () => {
      const offerId = arr2hex(randomBytes(20));
      const peer = (this.peers[offerId] = this._createPeer({
        initiator: true,
      }));
      peer.once("signal", (offer) => {
        offers.push({ offer, offer_id: hex2bin(offerId) });
        checkDone();
      });
      peer.trackerTimeout = setTimeout(() => {
        peer.trackerTimeout = null;
        delete this.peers[offerId];
        peer.destroy();
      }, OFFER_TIMEOUT);
      if (peer.trackerTimeout.unref) peer.trackerTimeout.unref();
    };
    for (let i = 0; i < numwant; ++i) {
      generateOffer();
    }
    checkDone();
  }
  _createPeer(opts) {
    const target = {
      trickle: false,
      config: this.client._rtcConfig,
      wrtc: this.client._wrtc,
    };
    opts = Object.assign(target, opts);
    const peer = new Peer(opts);
    const onError = (err) => {
      this.client.emit(
        "warning",
        new Error(`Connection error: ${err.message}`)
      );
      peer.destroy();
    };
    const onConnect = () => {
      peer.removeListener("error", onError);
      peer.removeListener("connect", onConnect);
    };
    peer.once("error", onError);
    peer.once("connect", onConnect);
    return peer;
  }
}
export default class Client extends EventEmitter {
  constructor(opts = {}) {
    super();
    if (!opts.peerId) throw new Error("Option `peerId` is required");
    if (!opts.infoHash) throw new Error("Option `infoHash` is required");
    if (!opts.announce) throw new Error("Option `announce` is required");
    if (!process.browser && !opts.port)
      throw new Error("Option `port` is required");
    this.peerId =
      typeof opts.peerId === "string" ? opts.peerId : arr2hex(opts.peerId);
    this._peerIdBuffer = hex2arr(this.peerId);
    this._peerIdBinary = hex2bin(this.peerId);
    this.infoHash =
      typeof opts.infoHash === "string"
        ? opts.infoHash.toLowerCase()
        : arr2hex(opts.infoHash);
    this._infoHashBuffer = hex2arr(this.infoHash);
    this._infoHashBinary = hex2bin(this.infoHash);
    this.destroyed = false;
    this._port = opts.port;
    this._getAnnounceOpts = opts.getAnnounceOpts;
    this._rtcConfig = opts.rtcConfig;
    this._userAgent = opts.userAgent;
    this._proxyOpts = opts.proxyOpts;
    this._wrtc = typeof opts.wrtc === "function" ? opts.wrtc() : opts.wrtc;
    let announce =
      typeof opts.announce === "string"
        ? [opts.announce]
        : opts.announce == null
        ? []
        : opts.announce;
    announce = announce.map((announceUrl) => {
      if (ArrayBuffer.isView(announceUrl)) announceUrl = arr2text(announceUrl);
      if (announceUrl[announceUrl.length - 1] === "/") {
        announceUrl = announceUrl.substring(0, announceUrl.length - 1);
      }
      return announceUrl;
    });
    announce = Array.from(new Set(announce));
    this._trackers = announce
      .map((announceUrl) => {
        return new WebSocketTracker(this, announceUrl);
      })
      .filter(Boolean);
  }
  start(opts = {}) {
    opts = this._defaultAnnounceOpts(opts);
    opts.event = "started";
    this._announce(opts);
    this._trackers.forEach((tracker) => {
      tracker.setInterval();
    });
  }
  stop(opts = {}) {
    opts = this._defaultAnnounceOpts(opts);
    opts.event = "stopped";
    this._announce(opts);
  }
  complete(opts) {
    if (!opts) opts = {};
    opts = this._defaultAnnounceOpts(opts);
    opts.event = "completed";
    this._announce(opts);
  }
  update(opts = {}) {
    opts = this._defaultAnnounceOpts(opts);
    if (opts.event) delete opts.event;
    this._announce(opts);
  }
  _announce(opts) {
    this._trackers.forEach((tracker) => {
      tracker.announce(opts);
    });
  }
  _scrape(opts, cb) {
    cb = once(cb);
    if (!opts.infoHash) throw new Error("Option `infoHash` is required");
    if (!opts.announce) throw new Error("Option `announce` is required");
    const clientOpts = Object.assign({}, opts, {
      infoHash: Array.isArray(opts.infoHash) ? opts.infoHash[0] : opts.infoHash,
      peerId: text2arr("01234567890123456789"),
      port: 6881,
    });
    const client = new Client(clientOpts);
    client.once("error", cb);
    client.once("warning", cb);
    let len = Array.isArray(opts.infoHash) ? opts.infoHash.length : 1;
    const results = {};
    client.on("scrape", (data) => {
      len -= 1;
      results[data.infoHash] = data;
      if (len === 0) {
        client.destroy();
        const keys = Object.keys(results);
        if (keys.length === 1) {
          cb(null, results[keys[0]]);
        } else {
          cb(null, results);
        }
      }
    });
    client.scrape({ infoHash: opts.infoHash });
    return client;
  }
  scrape(opts) {
    if (!opts) opts = {};
    this._trackers.forEach((tracker) => {
      tracker.scrape(opts);
    });
  }
  setInterval(intervalMs) {
    this._trackers.forEach((tracker) => {
      tracker.setInterval(intervalMs);
    });
  }
  destroy(cb = () => {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    this._trackers.foreach((tracker) => {
      tracker.destroy(cb);
    });
    this._trackers = [];
    this._getAnnounceOpts = null;
  }
  _defaultAnnounceOpts(opts = {}) {
    if (opts.numwant == null) opts.numwant = DEFAULT_ANNOUNCE_PEERS;
    if (opts.uploaded == null) opts.uploaded = 0;
    if (opts.downloaded == null) opts.downloaded = 0;
    if (this._getAnnounceOpts)
      opts = Object.assign({}, opts, this._getAnnounceOpts());
    return opts;
  }
}
