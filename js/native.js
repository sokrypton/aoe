// ---- NATIVE (Capacitor) DEEP-LINK BRIDGE ----
// Web-only no-op: this whole file bails immediately unless it is running inside
// the Capacitor Android shell, so it is harmless to ship in the web build too.
//
// A multiplayer host shares a link like https://ageofepochs.com/?join=<peerId>
// (see shareBaseUrl() in js/init.js). On a device that has the app installed,
// Android App Links (the autoVerify intent-filter in AndroidManifest.xml, proven
// by /.well-known/assetlinks.json on the site) route that URL into the app
// instead of the browser. This file catches that URL — both the cold-start case
// (app launched by the tap) and the warm case (app already open) — and drives
// the same guest-join / host-resume entry points the URL-param boot path uses
// (enterGuestJoinMode / enterHostResumeMode in js/init.js).
(function(){
  var Cap = window.Capacitor;
  if (!(Cap && Cap.isNativePlatform && Cap.isNativePlatform())) return;

  // Get a proxy for the @capacitor/app plugin without a bundler: the native
  // side auto-registers it, and registerPlugin() returns a bridge proxy.
  var App = null;
  try {
    if (typeof Cap.registerPlugin === 'function') App = Cap.registerPlugin('App');
    else if (Cap.Plugins) App = Cap.Plugins.App;
  } catch (e) {}
  if (!App || typeof App.addListener !== 'function') return;

  function routeUrl(url){
    if (!url) return;
    var join = null, host = null;
    try {
      var params = new URL(url).searchParams;
      join = params.get('join');
      host = params.get('host');
    } catch (e) { return; }
    // A ?join= link takes precedence over ?host= — same priority as the boot
    // path in js/init.js (joinHostId wins over resumeHostId).
    if (join && typeof enterGuestJoinMode === 'function') enterGuestJoinMode(join);
    else if (host && typeof enterHostResumeMode === 'function') enterHostResumeMode(host);
  }

  // Cold start: the app was launched by tapping a link. getLaunchUrl resolves
  // async (after init.js has finished defining the entry points and run its
  // normal local init(), which just means a brief local-world flash before the
  // join takes over — same as the retry path).
  if (typeof App.getLaunchUrl === 'function') {
    App.getLaunchUrl().then(function(res){ if (res) routeUrl(res.url); }).catch(function(){});
  }
  // Warm: a link tapped while the app is already running.
  App.addListener('appUrlOpen', function(data){ if (data) routeUrl(data.url); });
})();
