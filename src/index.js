const compressible = require('compressible');
const bytes = require('bytes');
const zlib = require('zlib');

const Buffer = require('safe-buffer').Buffer; // Creates a drop in replacement for the built in node.js Buffer
const accepts = require('accepts');
const debug = require('debug')('compression');
const onHeaders = require('on-headers');
const vary = require('vary');

const cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/; // Module variables

const toBuffer = (chunk, encoding) => ((!Buffer.isBuffer(chunk)) ? Buffer.from(chunk, encoding) : chunk); // Coerce arguments to Buffer

const addListeners = (stream, on, listeners) => { // Add buffered listeners to stream
  for (let i = 0; i < listeners.length; i++) { on.apply(stream, listeners[i]); }
};

const chunkLength = (chunk, encoding) => { // Get the length of a given chunk
  if (!chunk) { return 0; }
  return (!Buffer.isBuffer(chunk)) ? Buffer.byteLength(chunk, encoding) : chunk.length;
};

const shouldCompress = (req, res) => { // Default filter function
  const type = res.getHeader('Content-Type');
  if (type === undefined || !compressible(type)) {
    debug('%s not compressible', type);
    return false;
  }
  return true;
};

const shouldTransform = (req, res) => { // Determine if the entity should be transformed
  const cacheControl = res.getHeader('Cache-Control');
  // Don't compress for Cache-Control: no-transform -> https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl || !cacheControlNoTransformRegExp.test(cacheControl);
};

/**
 * Compress response data with gzip / deflate.
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */
const compression = function(options){
  const opts = options || {}; // options
  const filter = opts.filter || shouldCompress;
  let threshold = bytes.parse(opts.threshold);

  if (threshold == null) { threshold = 1024; }

  return function(req, res, next) {
    let ended = false, length, listeners = [], stream;
    const _end = res.end;
    const _on = res.on;
    const _write = res.write;

    res.flush = function flush() { if (stream) { stream.flush(); } }; // flush
    res.write = function write(chunk, encoding) { // proxy
      if (ended) { return false; }
      if (!this._header) { this._implicitHeader(); }
      return stream ? stream.write(toBuffer(chunk, encoding)) : _write.call(this, chunk, encoding);
    };

    res.end = function end(chunk, encoding) {
      if (ended) { return false; }
      if (!this._header) { // estimate the length
        if (!this.getHeader('Content-Length')) { length = chunkLength(chunk, encoding); }
        this._implicitHeader();
      }
      if (!stream) { return _end.call(this, chunk, encoding); }
      ended = true; // mark ended
      return chunk ? stream.end(toBuffer(chunk, encoding)) : stream.end(); // write Buffer for Node.js 0.8
    };

    res.on = function on(type, listener) {
      if (!listeners || type !== 'drain') { return _on.call(this, type, listener); }
      if (stream) { return stream.on(type, listener); }
      listeners.push([type, listener]); // buffer listeners for future stream
      return this;
    };

    const nocompress = (msg) => {
      debug('no compression: %s', msg);
      addListeners(res, _on, listeners);
      listeners = null;
    };

    onHeaders(res, () => {
      if (!filter(req, res)) { nocompress('filtered'); return; } // determine if request is filtered
      if (!shouldTransform(req, res)) { nocompress('no transform'); return; } // determine if the entity should be transformed
      vary(res, 'Accept-Encoding'); // vary

      // content-length below threshold
      if (Number(res.getHeader('Content-Length')) < threshold || length < threshold) { nocompress('size below threshold'); return; }
      const encoding = res.getHeader('Content-Encoding') || 'identity';
      if (encoding !== 'identity') { nocompress('already encoded'); return; } // already encoded
      if (req.method === 'HEAD') { nocompress('HEAD request'); return; } // head

      // compression method
      const accept = accepts(req);
      let method = accept.encoding(['gzip', 'deflate', 'identity']);
      if (method === 'deflate' && accept.encoding(['gzip'])) { method = accept.encoding(['gzip', 'identity']); } // we really don't prefer deflate
      if (!method || method === 'identity') { nocompress('not acceptable'); return; } // negotiation failed

      // compression stream
      debug('%s compression', method);
      stream = (method === 'gzip') ? zlib.createGzip(opts) : zlib.createDeflate(opts);
      addListeners(stream, stream.on, listeners); // add buffered listeners to stream
      res.setHeader('Content-Encoding', method); // header fields
      res.removeHeader('Content-Length');

      // compression
      stream.on('data', (chunk) => { if (_write.call(res, chunk) === false) { stream.pause(); } });
      stream.on('end', () => { _end.call(res); });
      _on.call(res, 'drain', () => { stream.resume(); });
    });
    next();
  };
};

// Module.exports
module.exports = compression;
module.exports.filter = shouldCompress;

/**
 * Koapress middleware
 * @param {Object} [options]
 * @return {Function}
 * @api public
 */
module.exports = (options = {}) => {

};
