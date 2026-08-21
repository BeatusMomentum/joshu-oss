/**
 * Persist open float-window layout across desktop refresh (same browser tab).
 * Restores URL, geometry, z-order, maximize/minimize after __arozOnDesktopInitComplete.
 * sessionStorage only — new tabs start clean; logout clears the snapshot.
 */
(function () {
  var STORAGE_KEY = "ao/desktop/float-session/v1";
  var SAVE_DEBOUNCE_MS = 200;
  var restoring = false;
  var saveTimer = null;
  var hooksInstalled = false;

  function safeParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }

  function isSafeUrl(url) {
    if (!url || typeof url !== "string") return false;
    var trimmed = url.trim();
    if (!trimmed || trimmed === "about:blank") return false;
    if (/^(javascript|data|vbscript):/i.test(trimmed)) return false;
    if (/^\/\//.test(trimmed)) return false;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return new URL(trimmed, window.location.href).origin === window.location.origin;
      } catch (_e) {
        return false;
      }
    }
    // Relative / same-path module URLs (SystemAO/..., subservice/..., etc.)
    return true;
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (_e) {
      /* private mode */
    }
  }

  function readSession() {
    try {
      var parsed = safeParse(sessionStorage.getItem(STORAGE_KEY));
      if (!parsed || !Array.isArray(parsed.windows)) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }

  function writeSession(windows) {
    try {
      if (!windows.length) {
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: 1, savedAt: Date.now(), windows: windows })
      );
    } catch (_e) {
      /* quota / private mode */
    }
  }

  function snapshotWindows($) {
    var wins = [];
    $(".floatWindow").each(function () {
      var $fw = $(this);
      var parentId = ($fw.attr("parent") || "").trim();
      // Child dialogs are tied to a live parent; skip so restore does not orphan them.
      if (parentId) return;

      var iframe = $fw.find("iframe")[0];
      var url = iframe ? iframe.getAttribute("src") || "" : "";
      if (!isSafeUrl(url)) return;

      var left = parseInt($fw.css("left"), 10);
      var top = parseInt($fw.css("top"), 10);
      if (isNaN(left)) left = Math.round($fw.offset().left) || 0;
      if (isNaN(top)) top = Math.round($fw.offset().top) || 0;

      wins.push({
        url: url,
        title: ($fw.find(".title").first().text() || "").trim(),
        appicon: $fw.find(".moduleicon").attr("src") || "img/system/favicon.png",
        left: left,
        top: top,
        width: Math.max(120, Math.round($fw.outerWidth()) || 854),
        height: Math.max(100, Math.round($fw.outerHeight()) || 480),
        z: parseInt($fw.css("z-index"), 10) || 0,
        max: $fw.attr("max") === "true",
        orgsize: $fw.attr("orgsize") || "",
        minimized: !$fw.is(":visible"),
        topmost: $fw.hasClass("topmost"),
        bgcolor: $fw.css("background-color") || "",
        // jChat tray dock vs icon-launched floating window.
        jchatDocked: $fw.hasClass("jp-jchat-docked"),
        jchatFloating: $fw.hasClass("jp-jchat-floating"),
        jchatDockHidden: $fw.hasClass("jp-jchat-dock-hidden"),
      });
    });
    // Stable stacking: lowest z first so later MoveFloatWindowToTop matches prior order.
    wins.sort(function (a, b) {
      return (a.z || 0) - (b.z || 0);
    });
    return wins;
  }

  function scheduleSave($, immediate) {
    if (restoring) return;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    var run = function () {
      saveTimer = null;
      if (restoring || typeof window.newFloatWindow !== "function") return;
      writeSession(snapshotWindows($));
    };
    if (immediate) run();
    else saveTimer = window.setTimeout(run, SAVE_DEBOUNCE_MS);
  }

  function clampGeometry(win) {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 720;
    var width = Math.min(Math.max(120, win.width || 854), vw);
    var height = Math.min(Math.max(100, win.height || 480), vh);
    var left = typeof win.left === "number" ? win.left : 100;
    var top = typeof win.top === "number" ? win.top : 100;
    // Keep title bar reachable after smaller viewports / rotated displays.
    if (left + 80 > vw) left = Math.max(0, vw - width);
    if (top + 40 > vh) top = Math.max(0, vh - 80);
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    return { left: left, top: top, width: width, height: height };
  }

  function isJChatUrl(url) {
    var u = String(url || "").toLowerCase();
    return u.indexOf("hermes-chat") !== -1 || u.indexOf("joshu-hermes-chat") !== -1;
  }

  function applyRestoredChrome($, fw, win, ctx) {
    if (!fw || !fw.length) return;
    if (win.orgsize) {
      $(fw).attr("orgsize", win.orgsize);
    }
    if (win.max) {
      $(fw).attr("max", "true");
      $(fw).find(".maxToogleButton").attr("src", "img/system/restore.svg");
      $(fw).find(".dockright, .dockleft").addClass("disabled");
    }
    if (win.minimized) {
      $(fw).hide();
    }
    // Restore tray-docked vs icon-launched jChat. Pre-split snapshots had no flag
    // and every jChat window was CSS-docked — treat those as the tray instance.
    if (isJChatUrl(win.url)) {
      var wantDocked;
      if (typeof win.jchatDocked === "boolean") wantDocked = win.jchatDocked;
      else if (win.jchatFloating === true) wantDocked = false;
      else wantDocked = true;
      if (wantDocked && ctx && ctx.dockedRestored) wantDocked = false;
      if (wantDocked) {
        fw.removeClass("jp-jchat-floating").addClass("jp-jchat-docked");
        fw.find(".fwcontrol .buttons.maxtoggle").attr("title", "Undock chat");
        if (win.jchatDockHidden) fw.addClass("jp-jchat-dock-hidden");
        if (ctx) ctx.dockedRestored = true;
      } else {
        fw.removeClass("jp-jchat-docked jp-jchat-dock-hidden").addClass("jp-jchat-floating");
      }
    }
  }

  function restoreSession($) {
    if (restoring) return;
    if (typeof window.newFloatWindow !== "function") return;
    // Fresh desktop only — never stack on top of an already-populated session.
    if ($(".floatWindow").length > 0) return;

    var session = readSession();
    if (!session || !session.windows.length) return;

    restoring = true;
    // Avoid Welcome auto-open racing a restored layout in the same tab.
    try {
      sessionStorage.setItem("joshu-onboarding-launched", "1");
    } catch (_e) {
      /* ignore */
    }

    var pending = session.windows.filter(function (win) {
      return win && isSafeUrl(win.url);
    });
    var idx = 0;
    var restoreCtx = { dockedRestored: false };

    function openNext() {
      if (idx >= pending.length) {
        restoring = false;
        scheduleSave($, true);
        return;
      }
      var win = pending[idx++];
      var geo = clampGeometry(win);
      var cfg = {
        url: win.url,
        title: win.title || "Window",
        appicon: win.appicon || "img/system/favicon.png",
        left: geo.left,
        top: geo.top,
        width: geo.width,
        height: geo.height,
      };
      try {
        window.newFloatWindow(cfg, function (uuid) {
          var fw =
            typeof window.getFloatWindowByID === "function"
              ? window.getFloatWindowByID(uuid)
              : $(".floatWindow[windowId='" + uuid + "']");
          applyRestoredChrome($, fw, win, restoreCtx);
          // Yield so taskbar grouping / z-index settle before the next window.
          window.setTimeout(openNext, 30);
        });
      } catch (_e) {
        window.setTimeout(openNext, 30);
      }
    }

    openNext();
  }

  function wrapGlobal(name, afterFn) {
    var orig = window[name];
    if (typeof orig !== "function") return false;
    window[name] = function () {
      var result = orig.apply(this, arguments);
      try {
        afterFn.apply(this, arguments);
      } catch (_e) {
        /* never break desktop chrome */
      }
      return result;
    };
    return true;
  }

  function installHooks($) {
    if (hooksInstalled) return;
    if (typeof window.newFloatWindow !== "function") return;
    hooksInstalled = true;

    wrapGlobal("newFloatWindow", function () {
      scheduleSave($);
    });
    wrapGlobal("closeFwProcess", function () {
      scheduleSave($);
    });
    wrapGlobal("fwup", function () {
      scheduleSave($);
    });
    wrapGlobal("resizeUp", function () {
      scheduleSave($);
    });
    wrapGlobal("min", function () {
      scheduleSave($);
    });
    wrapGlobal("toggleMax", function () {
      scheduleSave($);
    });
    wrapGlobal("dockWindowToLeft", function () {
      scheduleSave($);
    });
    wrapGlobal("dockWindowToRight", function () {
      scheduleSave($);
    });
    wrapGlobal("MoveFloatWindowToTop", function () {
      scheduleSave($);
    });

    // Account changes must not reopen the previous user's windows.
    wrapGlobal("logout", function () {
      clearSession();
    });
    wrapGlobal("switchAccount", function () {
      clearSession();
    });

    window.addEventListener("pagehide", function () {
      if (window.loggingOut) {
        clearSession();
        return;
      }
      scheduleSave($, true);
    });

    // Safety net when windows are appended/removed without hitting our wrappers.
    try {
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.addedNodes && m.addedNodes.length) {
            scheduleSave($);
            return;
          }
          if (m.removedNodes && m.removedNodes.length) {
            scheduleSave($);
            return;
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: false });
    } catch (_e) {
      /* MutationObserver unavailable */
    }
  }

  function chainInitComplete($) {
    var prev = window.__arozOnDesktopInitComplete;
    window.__arozOnDesktopInitComplete = function () {
      if (typeof prev === "function") {
        try {
          prev();
        } catch (_e) {
          /* keep restore path alive */
        }
      }
      // Slight delay so overlay-guard unblock + icon refresh finish first.
      window.setTimeout(function () {
        restoreSession($);
      }, 50);
    };

    // Late load: desktop already marked ready before this script chained.
    if (window.__arozDesktopInitComplete) {
      window.setTimeout(function () {
        restoreSession($);
      }, 50);
    }
  }

  function boot($) {
    installHooks($);
    chainInitComplete($);
    // Expose for DevTools / recovery scripts.
    window.arozSaveDesktopWindowSession = function () {
      scheduleSave($, true);
      return readSession();
    };
    window.arozClearDesktopWindowSession = clearSession;
    window.arozRestoreDesktopWindowSession = function () {
      restoreSession($);
    };
  }

  function tryBoot() {
    var jq = window.jQuery;
    if (!jq) return false;
    boot(jq);
    return true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      var n = 0;
      var t = window.setInterval(function () {
        if (tryBoot() || ++n > 80) window.clearInterval(t);
      }, 50);
    });
  } else {
    var n2 = 0;
    var t2 = window.setInterval(function () {
      if (tryBoot() || ++n2 > 80) window.clearInterval(t2);
    }, 50);
  }
})();
