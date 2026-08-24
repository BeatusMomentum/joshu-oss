/**
 * jChat desk — taskbar tray (avatar + mic + VU meter) and notification toasts.
 * Replaces the stock background-tasks button on the bottom-right nav strip.
 *
 * Two window modes:
 *   - Tray avatar / mic → one docked companion (class jp-jchat-docked).
 *   - Desktop icon / openModule("jChat") → a new floating window + new session.
 * Maximize on a docked window (and the in-app Undock control) pops it free.
 */
(function () {
  var METER_BARS = 10;
  var FLOAT_WIDTH = 480;
  var FLOAT_HEIGHT = 700;
  var DOCK_WIDTH = 400;
  var DOCK_HEIGHT = 720;

  var trayState = {
    assistantName: "John",
    portraitUrl: "",
    notification: null,
    notificationDismissed: false,
    voiceInputOn: false,
    voiceAvailable: false,
    audioLevel: 0,
    /** Hermes gateway: true | false | null (unknown / not polled yet). */
    gatewayRunning: null,
  };

  function jpQuery() {
    return window.jQuery || null;
  }

  function jpIsJChatFloatWindow($, fw) {
    if (!fw || !fw.length) return false;
    var src = String(fw.find("iframe").attr("src") || "").toLowerCase();
    if (src.indexOf("hermes-chat") !== -1 || src.indexOf("joshu-hermes-chat") !== -1) {
      return true;
    }
    return String(fw.find(".controls .title").first().text() || "").trim() === "jChat";
  }

  function jpFloatWindowElIsJChat(el) {
    if (!el || el.nodeType !== 1) return false;
    var iframe = el.querySelector("iframe");
    if (iframe) {
      var src = String(iframe.getAttribute("src") || "").toLowerCase();
      if (src.indexOf("hermes-chat") !== -1 || src.indexOf("joshu-hermes-chat") !== -1) {
        return true;
      }
    }
    var title = el.querySelector(".controls .title");
    return Boolean(title && String(title.textContent || "").trim() === "jChat");
  }

  function jpAllJChatWindows($) {
    var found = [];
    if (!$) return found;
    $(".floatWindow").each(function () {
      var fw = $(this);
      if (jpIsJChatFloatWindow($, fw)) found.push(fw);
    });
    return found;
  }

  function jpJChatDockedWindow($) {
    var all = jpAllJChatWindows($);
    for (var i = 0; i < all.length; i++) {
      if (all[i].hasClass("jp-jchat-docked")) return all[i];
    }
    return null;
  }

  /** First untagged jChat — upgrade path from the old "every jChat is docked" CSS. */
  function jpUntaggedJChatWindow($) {
    var all = jpAllJChatWindows($);
    var untagged = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].hasClass("jp-jchat-docked") || all[i].hasClass("jp-jchat-floating")) continue;
      untagged.push(all[i]);
    }
    return untagged.length === 1 ? untagged[0] : null;
  }

  function jpJChatIsOpen($) {
    var fw = jpJChatDockedWindow($);
    if (!fw || !fw.length) return false;
    return !fw.hasClass("jp-jchat-dock-hidden");
  }

  function jpWindowById(uuid) {
    if (!uuid) return null;
    var $ = jpQuery();
    if (typeof window.getFloatWindowByID === "function") {
      var fw = window.getFloatWindowByID(uuid);
      if (fw && fw.length) return fw;
    }
    if ($) {
      var byAttr = $(".floatWindow[windowId='" + uuid + "']");
      if (byAttr.length) return byAttr;
    }
    return null;
  }

  function jpNewestJChatWindow($) {
    var all = jpAllJChatWindows($);
    return all.length ? all[all.length - 1] : null;
  }

  function jpJChatIcon() {
    var mod = jpFindJChatModule();
    if (mod && (mod.IconPath || mod.iconPath)) return mod.IconPath || mod.iconPath;
    var $ = jpQuery();
    var all = jpAllJChatWindows($);
    for (var i = 0; i < all.length; i++) {
      var icon = all[i].find(".moduleicon").attr("src");
      if (icon) return icon;
    }
    return "img/joshu/chat.png";
  }

  function jpFindJChatModule() {
    var lists = [window.modules, window.Modules, window.loadedModules, window.moduleList];
    for (var c = 0; c < lists.length; c++) {
      var list = lists[c];
      if (!list) continue;
      if (!Array.isArray(list)) continue;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m) continue;
        if (m.Name === "jChat" || m.name === "jChat") return m;
      }
    }
    return null;
  }

  function jpSetMaxTitle(fw, text) {
    if (!fw || !fw.length) return;
    fw.find(".fwcontrol .buttons.maxtoggle").attr("title", text);
  }

  function jpMarkDocked(fw) {
    if (!fw || !fw.length) return fw;
    fw.removeClass("jp-jchat-floating").addClass("jp-jchat-docked");
    jpSetMaxTitle(fw, "Undock chat");
    return fw;
  }

  function jpMarkFloating(fw) {
    if (!fw || !fw.length) return fw;
    fw.removeClass("jp-jchat-docked jp-jchat-dock-hidden").addClass("jp-jchat-floating");
    jpSetMaxTitle(fw, "");
    return fw;
  }

  function jpSetJChatVisible(fw, visible) {
    if (!fw || !fw.length) return;
    if (visible) {
      fw.removeClass("jp-jchat-dock-hidden");
      if (typeof window.MoveFloatWindowToTop === "function") {
        window.MoveFloatWindowToTop(fw);
      }
    } else {
      fw.addClass("jp-jchat-dock-hidden");
    }
  }

  function jpUndockJChat(fw) {
    if (!fw || !fw.length) return;
    var width = FLOAT_WIDTH;
    var height = Math.min(FLOAT_HEIGHT, Math.round((window.innerHeight || 800) * 0.78));
    var left = Math.max(24, (window.innerWidth || 1200) - width - 80);
    var top = 48;
    jpMarkFloating(fw);
    fw.css({
      left: left + "px",
      top: top + "px",
      width: width + "px",
      height: height + "px",
    });
    if (typeof window.MoveFloatWindowToTop === "function") {
      window.MoveFloatWindowToTop(fw);
    }
    jpSyncTray();
  }

  function jpDockedIframe() {
    var $ = jpQuery();
    if (!$) return null;
    var fw = jpJChatDockedWindow($);
    if (!fw || !fw.length) return null;
    return fw.find("iframe")[0] || null;
  }

  function jpFloatWindowForSource(source) {
    var $ = jpQuery();
    if (!$ || !source) return null;
    var found = null;
    $(".floatWindow").each(function () {
      var iframe = this.querySelector("iframe");
      if (iframe && iframe.contentWindow === source) {
        found = $(this);
        return false;
      }
    });
    return found;
  }

  function jpFwIsVisible(fw) {
    if (!fw || !fw.length) return false;
    if (fw.hasClass("jp-jchat-dock-hidden")) return false;
    return fw.is(":visible");
  }

  function jpMeterBarHtml() {
    var html = "";
    for (var i = 0; i < METER_BARS; i++) {
      html += '<span class="jp-jchat-tray-meter-bar" data-idx="' + i + '"></span>';
    }
    return html;
  }

  function jpEnsureToastDom() {
    if (document.getElementById("jp-jchat-tray-toast")) return;

    var toast = document.createElement("div");
    toast.id = "jp-jchat-tray-toast";
    toast.className = "jp-jchat-tray-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.innerHTML =
      '<button type="button" class="jp-jchat-tray-toast-close" aria-label="Dismiss">×</button>' +
      '<img class="jp-jchat-tray-toast-photo" id="jp-jchat-tray-toast-img" alt="" />' +
      '<div class="jp-jchat-tray-toast-body">' +
      '<p class="jp-jchat-tray-toast-name"><span id="jp-jchat-tray-toast-dot"></span><span id="jp-jchat-tray-toast-name"></span></p>' +
      '<p class="jp-jchat-tray-toast-msg" id="jp-jchat-tray-toast-msg"></p>' +
      "</div>";

    document.body.appendChild(toast);

    toast.querySelector(".jp-jchat-tray-toast-close").addEventListener("click", function (evt) {
      evt.stopPropagation();
      trayState.notificationDismissed = true;
      trayState.notification = null;
      jpSyncTray();
    });
    toast.addEventListener("click", jpOpenDockedJChat);
  }

  function jpEnsureTrayDom() {
    var root = document.getElementById("backgroundtaskBtn");
    if (!root || root.getAttribute("data-jp-jchat-tray") === "1") return;

    root.setAttribute("data-jp-jchat-tray", "1");
    root.removeAttribute("onclick");
    root.removeAttribute("ontouchstart");
    root.classList.remove("clickable");
    root.classList.add("jp-jchat-tray-root");

    root.innerHTML =
      '<div class="jp-jchat-tray-controls">' +
      '<div id="jp-jchat-tray-meter" class="jp-jchat-tray-meter jp-jchat-tray-meter-off" aria-hidden="true">' +
      jpMeterBarHtml() +
      "</div>" +
      '<button type="button" id="jp-jchat-tray-mic" class="jp-jchat-tray-mic" aria-pressed="false" aria-label="Toggle voice mode" title="Voice mode">' +
      '<svg class="jp-jchat-tray-mic-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>' +
      "</svg>" +
      "</button>" +
      '<button type="button" id="jp-jchat-tray-avatar" class="jp-jchat-tray-avatar" aria-label="Open jChat">' +
      '<img id="jp-jchat-tray-avatar-img" alt="" />' +
      '<span id="jp-jchat-tray-badge" class="jp-jchat-tray-badge" hidden></span>' +
      '<span id="jp-jchat-tray-online" class="jp-jchat-tray-online" aria-hidden></span>' +
      "</button>" +
      "</div>";

    jpEnsureToastDom();

    root.querySelector("#jp-jchat-tray-avatar").addEventListener("click", jpToggleDockedJChat);
    root.querySelector("#jp-jchat-tray-mic").addEventListener("click", function (evt) {
      evt.stopPropagation();
      jpToggleVoice();
    });

    jpSwapClockAndTrayOrder();
  }

  /** float:right stacks right-to-left in DOM order — clock first = far right. */
  function jpSwapClockAndTrayOrder() {
    var root = document.getElementById("backgroundtaskBtn");
    var clock = document.querySelector("#navimenu .item.clock");
    if (!root || !clock || !root.parentNode) return;
    if (clock.nextElementSibling === root) return;
    root.parentNode.insertBefore(clock, root);
  }

  function jpSetVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
    el.classList.toggle("jp-jchat-tray-hidden", !visible);
  }

  function jpResolvePortrait(url) {
    if (url && String(url).trim()) return String(url).trim();
    return "./img/joshu/chat-portrait.jpg";
  }

  function jpUpdateMeter() {
    var meter = document.getElementById("jp-jchat-tray-meter");
    if (!meter) return;

    var voiceActive = trayState.voiceInputOn && trayState.voiceAvailable;
    meter.classList.toggle("jp-jchat-tray-meter-off", !voiceActive);

    var level = voiceActive ? Math.max(0, Math.min(1, trayState.audioLevel || 0)) : 0;
    var bars = meter.querySelectorAll(".jp-jchat-tray-meter-bar");
    for (var i = 0; i < bars.length; i++) {
      var threshold = (i + 1) / bars.length;
      bars[i].classList.toggle("jp-jchat-tray-meter-bar-lit", level >= threshold * 0.82);
    }
  }

  function jpUpdateMicButton() {
    var mic = document.getElementById("jp-jchat-tray-mic");
    if (!mic) return;

    var on = trayState.voiceInputOn && trayState.voiceAvailable;
    var disabled = !trayState.voiceAvailable;

    mic.classList.toggle("jp-jchat-tray-mic-on", on);
    mic.classList.toggle("jp-jchat-tray-mic-disabled", disabled);
    mic.setAttribute("aria-pressed", on ? "true" : "false");
    mic.setAttribute("aria-disabled", disabled ? "true" : "false");
    mic.title = disabled
      ? "Voice unavailable"
      : on
        ? "Voice mode on — click to mute"
        : "Voice mode off — click to talk";
  }

  function jpUpdateOnlineDot() {
    var online = document.getElementById("jp-jchat-tray-online");
    if (!online) return;
    var running = trayState.gatewayRunning;
    online.classList.toggle("is-up", running === true);
    online.classList.toggle("is-down", running === false);
    online.classList.toggle("is-unknown", running !== true && running !== false);
    var label =
      running === true
        ? "Hermes gateway running"
        : running === false
          ? "Hermes gateway stopped"
          : "Hermes gateway status unknown";
    online.setAttribute("title", label);
    online.setAttribute("aria-label", label);
    online.removeAttribute("aria-hidden");
  }

  function jpPollGatewayStatus() {
    fetch("/joshu/api/hermes/gateway", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (!json) {
          trayState.gatewayRunning = false;
        } else {
          trayState.gatewayRunning = Boolean(json.running);
        }
        jpUpdateOnlineDot();
      })
      .catch(function () {
        trayState.gatewayRunning = false;
        jpUpdateOnlineDot();
      });
  }

  function jpSyncTray() {
    jpEnsureTrayDom();
    var $ = jpQuery();
    var chatOpen = $ ? jpJChatIsOpen($) : false;

    if (chatOpen) {
      trayState.notificationDismissed = true;
      trayState.notification = null;
    }

    var portrait = jpResolvePortrait(trayState.portraitUrl);
    var avatarImg = document.getElementById("jp-jchat-tray-avatar-img");
    var toastImg = document.getElementById("jp-jchat-tray-toast-img");
    if (avatarImg) avatarImg.src = portrait;
    if (toastImg) toastImg.src = portrait;

    var nameEl = document.getElementById("jp-jchat-tray-toast-name");
    if (nameEl) nameEl.textContent = trayState.assistantName || "John";

    var msgEl = document.getElementById("jp-jchat-tray-toast-msg");
    if (msgEl) msgEl.textContent = trayState.notification || "";

    var hasNotification =
      Boolean(trayState.notification) && !trayState.notificationDismissed && !chatOpen;

    var badge = document.getElementById("jp-jchat-tray-badge");
    if (badge && hasNotification) badge.textContent = "1";
    jpSetVisible(badge, hasNotification);
    jpSetVisible(document.getElementById("jp-jchat-tray-toast"), hasNotification);

    var avatar = document.getElementById("jp-jchat-tray-avatar");
    if (avatar) {
      avatar.classList.toggle("jp-jchat-tray-avatar-open", chatOpen);
      avatar.title = chatOpen
        ? "Close chat with " + (trayState.assistantName || "John")
        : "Chat with " + (trayState.assistantName || "John");
      avatar.setAttribute("aria-label", chatOpen ? "Close jChat" : "Open jChat");
    }

    jpUpdateMicButton();
    jpUpdateMeter();
    jpUpdateOnlineDot();
  }

  function jpScheduleSyncTray() {
    window.setTimeout(jpSyncTray, 50);
    window.setTimeout(jpSyncTray, 250);
  }

  function jpPostVoiceToggle() {
    var iframe = jpDockedIframe();
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: "jchat:voice-toggle" }, "*");
      return true;
    }
    return false;
  }

  function jpToggleVoice() {
    if (!trayState.voiceAvailable) return;
    if (jpPostVoiceToggle()) return;

    jpOpenDockedJChat(function () {
      window.setTimeout(function () {
        jpPostVoiceToggle();
      }, 650);
    });
  }

  /**
   * Create a jChat float window. Prefer cloning an existing iframe src so the
   * subservice path matches ArozOS; first launch falls back to openModule.
   */
  function jpLaunchJChatWindow(mode, done) {
    var $ = jpQuery();
    var existingSrc = "";
    var all = jpAllJChatWindows($);
    for (var i = 0; i < all.length; i++) {
      var src = all[i].find("iframe").attr("src");
      if (src) {
        existingSrc = String(src);
        break;
      }
    }

    var finished = false;
    function finish(fw) {
      if (finished || !fw || !fw.length) return;
      finished = true;
      if (mode === "docked") jpMarkDocked(fw);
      else jpMarkFloating(fw);
      if (typeof done === "function") done(fw);
      jpSyncTray();
    }

    if (existingSrc && typeof window.newFloatWindow === "function") {
      var cfg = {
        url: existingSrc,
        title: "jChat",
        appicon: jpJChatIcon(),
        width: mode === "docked" ? DOCK_WIDTH : FLOAT_WIDTH,
        height: mode === "docked" ? DOCK_HEIGHT : FLOAT_HEIGHT,
      };
      if (mode === "floating") {
        cfg.left = 72 + Math.round(Math.random() * 48);
        cfg.top = 40 + Math.round(Math.random() * 36);
      }
      try {
        window.newFloatWindow(cfg, function (uuid) {
          finish(jpWindowById(uuid) || jpNewestJChatWindow($));
        });
      } catch (_e) {
        /* fall through to timeout */
      }
      window.setTimeout(function () {
        if (!finished) finish(jpNewestJChatWindow(jpQuery()));
      }, 280);
      return;
    }

    var opener = window.__jpOrigOpenModule || window.openModule;
    if (typeof opener !== "function") return;
    var beforeCount = all.length;
    opener.call(window, "jChat");
    window.setTimeout(function () {
      var now = jpQuery();
      var after = jpAllJChatWindows(now);
      if (after.length > beforeCount) {
        finish(jpNewestJChatWindow(now));
        return;
      }
      // Stock openModule reused a window. Clone a new instance when we now have a src.
      var newest = jpNewestJChatWindow(now);
      var cloneSrc = newest ? newest.find("iframe").attr("src") : "";
      if (cloneSrc && typeof window.newFloatWindow === "function") {
        var cloneCfg = {
          url: String(cloneSrc),
          title: "jChat",
          appicon: jpJChatIcon(),
          width: mode === "docked" ? DOCK_WIDTH : FLOAT_WIDTH,
          height: mode === "docked" ? DOCK_HEIGHT : FLOAT_HEIGHT,
        };
        if (mode === "floating") {
          cloneCfg.left = 72 + Math.round(Math.random() * 48);
          cloneCfg.top = 40 + Math.round(Math.random() * 36);
        }
        try {
          window.newFloatWindow(cloneCfg, function (uuid) {
            finish(jpWindowById(uuid) || jpNewestJChatWindow(jpQuery()));
          });
        } catch (_e) {
          finish(newest);
        }
        return;
      }
      finish(newest);
    }, 180);
  }

  function jpEnsureDockedWindow(done) {
    var $ = jpQuery();
    var docked = $ ? jpJChatDockedWindow($) : null;
    if (docked && docked.length) {
      if (typeof done === "function") done(docked);
      return;
    }
    var untagged = $ ? jpUntaggedJChatWindow($) : null;
    if (untagged && untagged.length) {
      jpMarkDocked(untagged);
      if (typeof done === "function") done(untagged);
      jpSyncTray();
      return;
    }
    jpLaunchJChatWindow("docked", done);
  }

  function jpOpenDockedJChat(done) {
    trayState.notificationDismissed = true;
    trayState.notification = null;

    jpEnsureDockedWindow(function (fw) {
      jpSetJChatVisible(fw, true);
      jpSyncTray();
      if (typeof done === "function") done(fw);
    });
  }

  function jpToggleDockedJChat() {
    trayState.notificationDismissed = true;
    trayState.notification = null;

    var $ = jpQuery();
    var fw = $ ? jpJChatDockedWindow($) : null;
    if (fw && fw.length) {
      jpSetJChatVisible(fw, !jpJChatIsOpen($));
      jpSyncTray();
      return;
    }

    jpOpenDockedJChat();
  }

  function jpHookOpenModule() {
    if (typeof window.openModule !== "function") return false;
    if (window.openModule.__jpJChatWrapped) return true;
    var orig = window.openModule;
    window.__jpOrigOpenModule = orig;
    function wrapped(name) {
      if (String(name || "") !== "jChat") {
        return orig.apply(this, arguments);
      }
      // Desktop icon / start menu / agent "open jChat" → new floating session.
      jpLaunchJChatWindow("floating");
    }
    wrapped.__jpJChatWrapped = true;
    window.openModule = wrapped;
    return true;
  }

  /** Maximize on a docked window undocks instead of zooming. */
  function jpInstallChromeSync() {
    document.addEventListener(
      "mousedown",
      function (evt) {
        var target = evt.target;
        if (!target || !target.closest) return;
        var fwEl = target.closest(".floatWindow");
        if (!fwEl || !jpFloatWindowElIsJChat(fwEl)) return;

        if (target.closest(".buttons.maxtoggle") && fwEl.classList.contains("jp-jchat-docked")) {
          evt.preventDefault();
          evt.stopPropagation();
          var $ = jpQuery();
          if ($) jpUndockJChat($(fwEl));
          return;
        }

        if (!target.closest(".buttons.closetoggle, .buttons.close")) return;
        jpScheduleSyncTray();
      },
      true
    );
  }

  /** When ArozOS removes a jChat float window from the DOM, refresh tray state. */
  function jpInstallFloatWindowObserver() {
    if (typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function (mutations) {
      var changed = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var list = m.type === "childList" ? m.removedNodes : null;
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
          if (jpFloatWindowElIsJChat(list[j])) {
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (changed) jpSyncTray();
    });
    obs.observe(document.body, { childList: true });
  }

  function jpInstallMessageListener() {
    window.addEventListener("message", function (evt) {
      var data = evt.data;
      if (!data || !data.type) return;

      if (data.type === "jchat:undock") {
        var undockFw = jpFloatWindowForSource(evt.source);
        if (undockFw && undockFw.hasClass("jp-jchat-docked")) jpUndockJChat(undockFw);
        return;
      }

      if (data.type !== "jchat:tray") return;
      if (typeof data.assistantName === "string") trayState.assistantName = data.assistantName;
      if (typeof data.portraitUrl === "string") trayState.portraitUrl = data.portraitUrl;
      if (typeof data.gatewayRunning === "boolean") trayState.gatewayRunning = data.gatewayRunning;
      if (typeof data.notification === "string" && data.notification.trim()) {
        var sourceFw = jpFloatWindowForSource(evt.source);
        // Skip the toast when the sending window is already on screen.
        if (sourceFw && jpFwIsVisible(sourceFw)) {
          trayState.notification = null;
        } else {
          trayState.notification = data.notification.trim();
          var $n = jpQuery();
          trayState.notificationDismissed = $n ? jpJChatIsOpen($n) : false;
        }
      }
      // Voice VU / mic state come from the docked companion only.
      var voiceFw = jpFloatWindowForSource(evt.source);
      var isDockedVoice = Boolean(voiceFw && voiceFw.hasClass("jp-jchat-docked"));
      if (isDockedVoice || !jpQuery() || !jpJChatDockedWindow(jpQuery())) {
        if (typeof data.voiceInputOn === "boolean") trayState.voiceInputOn = data.voiceInputOn;
        if (typeof data.voiceAvailable === "boolean") trayState.voiceAvailable = data.voiceAvailable;
        if (typeof data.audioLevel === "number" && !Number.isNaN(data.audioLevel)) {
          trayState.audioLevel = data.audioLevel;
        }
      }
      jpSyncTray();
    });
  }

  function jpHookTaskbar($) {
    $(document.body).on("mousedown click", ".floatWindowButton", function () {
      jpScheduleSyncTray();
    });
  }

  function jpBoot() {
    var legacy = document.getElementById("jp-jchat-tray-root");
    if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);

    jpEnsureTrayDom();
    jpSwapClockAndTrayOrder();
    jpInstallMessageListener();
    jpInstallChromeSync();
    jpInstallFloatWindowObserver();
    jpHookOpenModule();

    var $ = jpQuery();
    if ($) jpHookTaskbar($);

    // openModule is defined by desktop.html; retry if this overlay won the race.
    if (!jpHookOpenModule()) {
      var tries = 0;
      var timer = window.setInterval(function () {
        if (jpHookOpenModule() || ++tries > 40) window.clearInterval(timer);
      }, 50);
    }

    fetch("/joshu/api/instance/identity", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (!json) return;
        if (json.name) trayState.assistantName = json.name;
        trayState.portraitUrl = json.avatarUrl || json.imageUrl || "";
        jpSyncTray();
      })
      .catch(function () {});

    fetch("/joshu/api/voice/status", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (!json) return;
        trayState.voiceAvailable = Boolean(json.available);
        jpSyncTray();
      })
      .catch(function () {});

    jpPollGatewayStatus();
    window.setInterval(jpPollGatewayStatus, 5000);

    jpSyncTray();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", jpBoot);
  } else {
    jpBoot();
  }
})();
