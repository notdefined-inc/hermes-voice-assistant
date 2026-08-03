/**
 * Supertonic 3 browser-local TTS engine for the Hermes voice assistant.
 *
 * The model and ONNX Runtime assets are same-origin extension assets. Inference
 * prefers WebGPU and falls back to single-threaded WASM. The engine is lazy:
 * nothing is downloaded until Supertonic is actually used for the first time.
 */
(function () {
  'use strict';

  var ROOT = '/extensions/voice-assistant/assets/';
  var MODEL_ROOT = ROOT + 'supertonic/onnx/';
  var STYLE_ROOT = ROOT + 'supertonic/voice_styles/';
  var ORT_SCRIPT = ROOT + 'vendor/ort.all.min.js';
  var ORT_WASM_ROOT = ROOT + 'vendor/';
  var LANGS = { en: true, hi: true, na: true };
  var VOICES = { M1: true, M2: true, M3: true, M4: true, M5: true,
    F1: true, F2: true, F3: true, F4: true, F5: true };

  var state = {
    ortPromise: null,
    modelPromise: null,
    styleCache: Object.create(null),
    queue: Promise.resolve(),
    backend: null,
    tts: null,
    cfgs: null,
    processor: null,
  };

  function notify(message, duration) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast('Supertonic: ' + message, duration || 3500);
      }
    } catch (_) {}
    try { console.info('[Supertonic]', message); } catch (_) {}
  }

  function clampNumber(value, min, max, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function normalizeOptions(opts) {
    opts = opts || {};
    var voice = String(opts.voice || 'M1').toUpperCase();
    if (!VOICES[voice]) voice = 'M1';
    var lang = String(opts.lang || 'na').toLowerCase();
    if (!LANGS[lang]) lang = 'na';
    var steps = Math.round(clampNumber(
      opts.steps !== undefined ? opts.steps : opts.totalSteps,
      5, 12, 5
    ));
    var speed = clampNumber(opts.speed, 0.7, 2.0, 1.05);
    return { voice: voice, lang: lang, steps: steps, speed: speed };
  }

  function loadScript(src) {
    if (window.ort) return Promise.resolve(window.ort);
    if (state.ortPromise) return state.ortPromise;

    state.ortPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-supertonic-ort="1"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.ort); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('ONNX Runtime failed to load')); }, { once: true });
        return;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.supertonicOrt = '1';
      script.onload = function () {
        if (!window.ort) reject(new Error('ONNX Runtime loaded without the ort global'));
        else resolve(window.ort);
      };
      script.onerror = function () { reject(new Error('ONNX Runtime failed to load')); };
      document.head.appendChild(script);
    });
    return state.ortPromise;
  }

  function fetchJson(path) {
    return fetch(path, { cache: 'force-cache' }).then(function (response) {
      if (!response.ok) throw new Error('Could not load ' + path + ' (' + response.status + ')');
      return response.json();
    });
  }

  function isValidLang(lang) { return !!LANGS[lang]; }

  function preprocessText(text, lang, indexer) {
    text = String(text || '').normalize('NFKD');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
    var replacements = {
      '–': '-', '‑': '-', '—': '-', '_': ' ',
      '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'", '´': "'", '`': "'",
      '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' '
    };
    Object.keys(replacements).forEach(function (key) {
      text = text.replaceAll(key, replacements[key]);
    });
    text = text.replace(/[♥☆♡©\\]/g, '');
    text = text.replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ');
    text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
      .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
    while (text.includes('""')) text = text.replace('""', '"');
    while (text.includes("''")) text = text.replace("''", "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) text = ' .';
    if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
    if (!isValidLang(lang)) throw new Error('Unsupported Supertonic language: ' + lang);
    text = '<' + lang + '>' + text + '</' + lang + '>';

    var ids = [];
    for (var i = 0; i < text.length; i++) {
      var codePoint = text.codePointAt(i);
      ids.push(codePoint < indexer.length ? indexer[codePoint] : -1);
    }
    return ids;
  }

  function buildTextInputs(text, lang, indexer) {
    var ids = preprocessText(text, lang, indexer);
    var row = new Array(ids.length);
    for (var i = 0; i < ids.length; i++) row[i] = ids[i];
    return {
      textIds: [row],
      textMask: [[[].concat(new Array(ids.length).fill(1.0))]],
    };
  }

  function loadStyle(ort, voice) {
    if (state.styleCache[voice]) return Promise.resolve(state.styleCache[voice]);
    return fetchJson(STYLE_ROOT + voice + '.json').then(function (raw) {
      var ttlDims = raw.style_ttl.dims;
      var dpDims = raw.style_dp.dims;
      var ttlData = new Float32Array(raw.style_ttl.data.flat(Infinity));
      var dpData = new Float32Array(raw.style_dp.data.flat(Infinity));
      var style = {
        ttl: new ort.Tensor('float32', ttlData, [1, ttlDims[1], ttlDims[2]]),
        dp: new ort.Tensor('float32', dpData, [1, dpDims[1], dpDims[2]])
      };
      state.styleCache[voice] = style;
      return style;
    });
  }

  function lengthToMask(lengths, maxLen) {
    var actualMax = maxLen || Math.max.apply(Math, lengths);
    return lengths.map(function (len) {
      var row = new Array(actualMax).fill(0.0);
      for (var i = 0; i < Math.min(len, actualMax); i++) row[i] = 1.0;
      return [row];
    });
  }

  function randomNormal() {
    var u1 = Math.max(0.0001, Math.random());
    var u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  function sampleNoisyLatent(duration, cfgs, sampleRate) {
    var maxDur = Math.max.apply(Math, duration);
    var wavLenMax = Math.floor(maxDur * sampleRate);
    var wavLengths = duration.map(function (d) { return Math.floor(d * sampleRate); });
    var chunkSize = cfgs.ae.base_chunk_size * cfgs.ttl.chunk_compress_factor;
    var latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    var latentDim = cfgs.ttl.latent_dim * cfgs.ttl.chunk_compress_factor;
    var xt = [];
    for (var b = 0; b < duration.length; b++) {
      var batch = [];
      for (var d = 0; d < latentDim; d++) {
        var row = [];
        for (var t = 0; t < latentLen; t++) row.push(randomNormal());
        batch.push(row);
      }
      xt.push(batch);
    }
    var latentLengths = wavLengths.map(function (len) {
      return Math.floor((len + chunkSize - 1) / chunkSize);
    });
    var mask = lengthToMask(latentLengths, latentLen);
    for (var bi = 0; bi < xt.length; bi++) {
      for (var di = 0; di < latentDim; di++) {
        for (var ti = 0; ti < latentLen; ti++) xt[bi][di][ti] *= mask[bi][0][ti];
      }
    }
    return { xt: xt, latentMask: mask };
  }

  function flatten2(values) { return new Float32Array(values.flat(2)); }

  async function infer(text, lang, style, steps, speed) {
    var ort = window.ort;
    var ids = preprocessText(text, lang, state.processor);
    var textIds = [ids];
    var textMask = [[[].concat(new Array(ids.length).fill(1.0))]];
    var textIdsTensor = new ort.Tensor('int64', new BigInt64Array(ids.map(function (x) { return BigInt(x); })), [1, ids.length]);
    var textMaskTensor = new ort.Tensor('float32', flatten2(textMask), [1, 1, ids.length]);

    var dpOutputs = await state.dp.run({ text_ids: textIdsTensor, style_dp: style.dp, text_mask: textMaskTensor });
    var duration = Array.from(dpOutputs.duration.data);
    for (var i = 0; i < duration.length; i++) duration[i] /= speed;

    var textEncOutputs = await state.textEncoder.run({ text_ids: textIdsTensor, style_ttl: style.ttl, text_mask: textMaskTensor });
    var textEmb = textEncOutputs.text_emb;
    var sampled = sampleNoisyLatent(duration, state.cfgs, state.tts.sampleRate);
    var xt = sampled.xt;
    var latentMask = sampled.latentMask;
    var latentMaskTensor = new ort.Tensor('float32', flatten2(latentMask), [1, 1, latentMask[0][0].length]);
    var totalStepTensor = new ort.Tensor('float32', new Float32Array([steps]), [1]);

    for (var step = 0; step < steps; step++) {
      var currentStepTensor = new ort.Tensor('float32', new Float32Array([step]), [1]);
      var xtTensor = new ort.Tensor('float32', flatten2(xt), [1, xt[0].length, xt[0][0].length]);
      var outputs = await state.vectorEstimator.run({
        noisy_latent: xtTensor,
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMaskTensor,
        text_mask: textMaskTensor,
        current_step: currentStepTensor,
        total_step: totalStepTensor
      });
      var denoised = Array.from(outputs.denoised_latent.data);
      var latentDim = xt[0].length;
      var latentLen = xt[0][0].length;
      xt = [];
      var index = 0;
      for (var b = 0; b < 1; b++) {
        var batch = [];
        for (var d = 0; d < latentDim; d++) {
          var row = [];
          for (var t = 0; t < latentLen; t++) row.push(denoised[index++]);
          batch.push(row);
        }
        xt.push(batch);
      }
    }

    var vocoderOutputs = await state.vocoder.run({
      latent: new ort.Tensor('float32', flatten2(xt), [1, xt[0].length, xt[0][0].length])
    });
    return { wav: Array.from(vocoderOutputs.wav_tts.data), duration: duration };
  }

  function splitText(text, maxLen) {
    var paragraphs = String(text || '').trim().split(/\n\s*\n+/).filter(function (p) { return p.trim(); });
    var chunks = [];
    paragraphs.forEach(function (paragraph) {
      var sentences = paragraph.trim().split(/(?<=[.!?])\s+/);
      var current = '';
      sentences.forEach(function (sentence) {
        if (current && current.length + sentence.length + 1 > maxLen) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current += (current ? ' ' : '') + sentence;
        }
      });
      if (current) chunks.push(current.trim());
    });
    if (!chunks.length && String(text || '').trim()) chunks.push(String(text).trim().slice(0, maxLen));
    return chunks;
  }

  function writeWavFile(audioData, sampleRate) {
    var dataSize = audioData.length * 2;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    function writeString(offset, value) {
      for (var i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    }
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    for (var j = 0; j < audioData.length; j++) {
      var sample = Math.max(-1, Math.min(1, audioData[j]));
      view.setInt16(44 + j * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
  }

  function loadModels() {
    if (state.modelPromise) return state.modelPromise;
    state.modelPromise = loadScript(ORT_SCRIPT).then(function (ort) {
      // ORT's execution-provider assignment notice is informational: shape and
      // control-flow ops are deliberately left on CPU even with WebGPU. Keep
      // genuine errors visible without presenting that expected split as a
      // failure to users.
      try { ort.env.logLevel = 'error'; } catch (_) {}
      ort.env.wasm.wasmPaths = ORT_WASM_ROOT;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      notify('loading the local model (first use is about 400 MB)…', 7000);
      return Promise.all([fetchJson(MODEL_ROOT + 'tts.json'), fetchJson(MODEL_ROOT + 'unicode_indexer.json')])
        .then(function (meta) {
          state.cfgs = meta[0];
          state.processor = meta[1];
          var paths = [
            MODEL_ROOT + 'duration_predictor.onnx',
            MODEL_ROOT + 'text_encoder.onnx',
            MODEL_ROOT + 'vector_estimator.onnx',
            MODEL_ROOT + 'vocoder.onnx'
          ];
          function createSessions(executionProviders) {
            var options = {
              executionProviders: executionProviders,
              graphOptimizationLevel: 'all',
              logSeverityLevel: 3
            };
            return Promise.all(paths.map(function (path) { return ort.InferenceSession.create(path, options); }));
          }
          return createSessions(['webgpu']).then(function (sessions) {
            state.backend = 'webgpu';
            return sessions;
          }).catch(function (webgpuError) {
            console.warn('[Supertonic] WebGPU unavailable, falling back to WASM:', webgpuError);
            return createSessions(['wasm']).then(function (sessions) {
              state.backend = 'wasm';
              return sessions;
            });
          });
        }).then(function (sessions) {
          state.dp = sessions[0];
          state.textEncoder = sessions[1];
          state.vectorEstimator = sessions[2];
          state.vocoder = sessions[3];
          state.tts = { sampleRate: state.cfgs.ae.sample_rate };
          notify('ready (' + state.backend + ')', 2500);
          return state;
        });
    }).catch(function (error) {
      state.modelPromise = null;
      notify('could not initialise: ' + error.message, 5000);
      throw error;
    });
    return state.modelPromise;
  }

  async function synthesizeNow(text, opts) {
    var options = normalizeOptions(opts);
    await loadModels();
    var style = await loadStyle(window.ort, options.voice);
    var chunks = splitText(text, 300);
    var wav = [];
    var totalDuration = 0;
    for (var i = 0; i < chunks.length; i++) {
      var result = await infer(chunks[i], options.lang, style, options.steps, options.speed);
      if (wav.length) {
        var silence = Math.floor(0.3 * state.tts.sampleRate);
        for (var s = 0; s < silence; s++) wav.push(0);
        totalDuration += 0.3;
      }
      wav = wav.concat(result.wav);
      totalDuration += result.duration[0];
    }
    if (!wav.length) throw new Error('Supertonic produced no audio');
    var sampleCount = Math.min(wav.length, Math.floor(totalDuration * state.tts.sampleRate));
    return writeWavFile(wav.slice(0, sampleCount), state.tts.sampleRate);
  }

  function synthesize(text, opts) {
    var run = state.queue.then(function () { return synthesizeNow(text, opts); });
    state.queue = run.catch(function () {});
    return run;
  }

  window._supertonicTtsState = state;

  function register() {
    if (typeof window.registerHermesTtsEngine !== 'function') {
      setTimeout(register, 100);
      return;
    }
    window.registerHermesTtsEngine({
      id: 'supertonic',
      label: 'Supertonic 3 (local)',
      synthesize: synthesize
    });
    console.info('[Supertonic] WebUI TTS engine registered');
  }
  register();
})();
