// html.js: escaping text for HTML. Loads as a classic browser script and as a
// CommonJS module for the Node tests.

'use strict';

var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeChar(c) { return HTML_ESCAPES[c]; }

// Safe in element text and inside a quoted attribute. null and undefined
// become an empty string.
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, escapeChar);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml: escapeHtml };
}
