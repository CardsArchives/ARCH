/**
 * ARCH — Mini Discord Embedded App SDK
 * Compatible avec @discord/embedded-app-sdk@1.x
 * Implémente: ready(), commands.authorize(), commands.authenticate()
 */
(function(global) {
  'use strict';

  var CMD = {
    AUTHORIZE:    'AUTHORIZE',
    AUTHENTICATE: 'AUTHENTICATE',
    READY:        'READY',
  };

  var SOURCE = 'discord-embedded-app-sdk';

  function DiscordSDK(clientId, options) {
    this.clientId    = clientId;
    this.frameId     = (options && options.frameId)    || getParam('frame_id');
    this.instanceId  = (options && options.instanceId) || getParam('instance_id');
    this._ready      = false;
    this._pendingCmds = {};
    this._cmdId      = 0;

    var self = this;
    window.addEventListener('message', function(ev) {
      self._onMessage(ev);
    });
  }

  function getParam(name) {
    return new URLSearchParams(window.location.search).get(name) || undefined;
  }

  DiscordSDK.prototype._onMessage = function(ev) {
    try {
      var data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (!data || data.source !== 'discord') return;

      // Ready signal
      if (data.evt === 'READY' || data.cmd === 'READY') {
        this._ready = true;
        if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
      }

      // Command response
      var nonce = data.nonce;
      if (nonce && this._pendingCmds[nonce]) {
        var pending = this._pendingCmds[nonce];
        delete this._pendingCmds[nonce];
        if (data.evt === 'ERROR') {
          pending.reject(new Error(data.data && data.data.message || 'Discord command error'));
        } else {
          pending.resolve(data.data || {});
        }
      }
    } catch(e) {}
  };

  DiscordSDK.prototype._send = function(cmd, args) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var nonce = String(++self._cmdId) + '_' + Date.now();
      self._pendingCmds[nonce] = { resolve: resolve, reject: reject };
      var msg = { cmd: cmd, nonce: nonce, args: args || {} };
      try {
        window.parent.postMessage(msg, '*');
      } catch(e) {
        reject(new Error('postMessage failed: ' + e.message));
      }
      // Timeout après 10s
      setTimeout(function() {
        if (self._pendingCmds[nonce]) {
          delete self._pendingCmds[nonce];
          reject(new Error('Discord command timeout: ' + cmd));
        }
      }, 10000);
    });
  };

  DiscordSDK.prototype.ready = function() {
    var self = this;
    return new Promise(function(resolve) {
      if (self._ready) return resolve();
      self._readyResolve = resolve;
      // Envoie le signal ready au parent Discord
      try { window.parent.postMessage({ cmd: 'SET_ACTIVITY', source: SOURCE }, '*'); } catch(e) {}
      // Timeout fallback — si Discord ne répond pas, on continue quand même
      setTimeout(function() { self._ready = true; resolve(); }, 3000);
    });
  };

  DiscordSDK.prototype.commands = {
    authorize: function(params) {
      return this._send(CMD.AUTHORIZE, params);
    }.bind(DiscordSDK.prototype),
    authenticate: function(params) {
      return this._send(CMD.AUTHENTICATE, params);
    }.bind(DiscordSDK.prototype),
  };

  // Fix: bind commands to instance
  var _origInit = DiscordSDK;
  DiscordSDK = function(clientId, options) {
    _origInit.call(this, clientId, options);
    var self = this;
    this.commands = {
      authorize: function(params) { return self._send(CMD.AUTHORIZE, params); },
      authenticate: function(params) { return self._send(CMD.AUTHENTICATE, params); },
    };
  };
  DiscordSDK.prototype = _origInit.prototype;

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DiscordSDK: DiscordSDK };
  } else {
    global.DiscordSDK = DiscordSDK;
    global.EmbeddedAppSDK = { DiscordSDK: DiscordSDK };
  }

})(typeof window !== 'undefined' ? window : this);
