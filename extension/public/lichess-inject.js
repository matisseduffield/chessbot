// Injected into Lichess/PlayStrategy page context at document_start.
// Chessground's drag.start() rejects synthetic events via:
//   if (!(s.trustAllEvents || e.isTrusted)) return;
// This script wraps mousedown/touchstart/pointerdown handlers on cg-board
// so that events marked with detail=42424242 get a Proxy that reports
// isTrusted=true, allowing the chessbot extension to execute moves.
(function () {
  var MARKER = 42424242;
  var orig = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (
      this &&
      this.tagName === "CG-BOARD" &&
      (type === "mousedown" || type === "touchstart" || type === "pointerdown")
    ) {
      var wrapped = function (event) {
        if (event.detail === MARKER) {
          var proxy = new Proxy(event, {
            get: function (target, prop) {
              if (prop === "isTrusted") return true;
              var val = Reflect.get(target, prop, target);
              return typeof val === "function" ? val.bind(target) : val;
            },
          });
          return listener.call(this, proxy);
        }
        return listener.call(this, event);
      };
      return orig.call(this, type, wrapped, options);
    }
    return orig.call(this, type, listener, options);
  };
})();
