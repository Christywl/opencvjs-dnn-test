// Copyright 2015 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// Pthread Web Worker startup routine:
// This is the entry point file that is loaded first by each Web Worker
// that executes pthreads on the Emscripten application.

// Thread-local:
var threadInfoStruct = 0; // Info area for this thread in Emscripten HEAP (shared). If zero, this worker is not currently hosting an executing pthread.
var selfThreadId = 0; // The ID of this thread. 0 if not hosting a pthread.
var parentThreadId = 0; // The ID of the parent pthread that launched this thread.

// Thread-local: Each thread has its own allocated stack space.
var STACK_BASE = 0;
var STACKTOP = 0;
var STACK_MAX = 0;

// These are system-wide memory area parameters that are set at main runtime startup in main thread, and stay constant throughout the application.
var buffer; // All pthreads share the same Emscripten HEAP as SharedArrayBuffer with the main execution thread.
var DYNAMICTOP_PTR = 0;
var DYNAMIC_BASE = 0;

var noExitRuntime;

var PthreadWorkerInit = {};

// performance.now() is specced to return a wallclock time in msecs since that Web Worker/main thread launched. However for pthreads this can cause
// subtle problems in emscripten_get_now() as this essentially would measure time from pthread_create(), meaning that the clocks between each threads
// would be wildly out of sync. Therefore sync all pthreads to the clock on the main browser thread, so that different threads see a somewhat
// coherent clock across each of them (+/- 0.1msecs in testing)
var __performance_now_clock_drift = 0;

// Cannot use console.log or console.error in a web worker, since that would risk a browser deadlock! https://bugzilla.mozilla.org/show_bug.cgi?id=1049091
// Therefore implement custom logging facility for threads running in a worker, which queue the messages to main thread to print.
var Module = {};

// These modes need to assign to these variables because of how scoping works in them.
var PThread;
var HEAPU32;


// When error objects propagate from Web Worker to main thread, they lose helpful call stack and thread ID information, so print out errors early here,
// before that happens.
this.addEventListener('error', function(e) {
  if (e.message.indexOf('SimulateInfiniteLoop') != -1) return e.preventDefault();

  var errorSource = ' in ' + e.filename + ':' + e.lineno + ':' + e.colno;
  console.error('Pthread ' + selfThreadId + ' uncaught exception' + (e.filename || e.lineno || e.colno ? errorSource : "") + ': ' + e.message + '. Error object:');
  console.error(e.error);
});

function threadPrintErr() {
  var text = Array.prototype.slice.call(arguments).join(' ');
  console.error(text);
  console.error(new Error().stack);
}
function threadAlert() {
  var text = Array.prototype.slice.call(arguments).join(' ');
  postMessage({cmd: 'alert', text: text, threadId: selfThreadId});
}
var err = threadPrintErr;
this.alert = threadAlert;

// When using postMessage to send an object, it is processed by the structured clone algorithm.
// The prototype, and hence methods, on that object is then lost. This function adds back the lost prototype.
// This does not work with nested objects that has prototypes, but it suffices for WasmSourceMap and WasmOffsetConverter.
function resetPrototype(constructor, attrs) {
  var object = Object.create(constructor.prototype);
  for (var key in attrs) {
    if (attrs.hasOwnProperty(key)) {
      object[key] = attrs[key];
    }
  }
  return object;
}

Module['instantiateWasm'] = function(info, receiveInstance) {
  // Instantiate from the module posted from the main thread.
  // We can just use sync instantiation in the worker.
  var instance = new WebAssembly.Instance(wasmModule, info);
  // We don't need the module anymore; new threads will be spawned from the main thread.
  wasmModule = null;
  receiveInstance(instance); // The second 'module' parameter is intentionally null here, we don't need to keep a ref to the Module object from here.
  return instance.exports;
};

var wasmModule;
var wasmMemory;

this.onmessage = function(e) {
  try {
    if (e.data.cmd === 'load') { // Preload command that is called once per worker to parse and load the Emscripten code.

      // Initialize the global "process"-wide fields:
      Module['DYNAMIC_BASE'] = DYNAMIC_BASE = e.data.DYNAMIC_BASE;
      Module['DYNAMICTOP_PTR'] = DYNAMICTOP_PTR = e.data.DYNAMICTOP_PTR;

      // The Wasm module will have import fields for STACKTOP and STACK_MAX. At 'load' stage of Worker startup, we are just
      // spawning this Web Worker to act as a host for future created pthreads, i.e. we do not have a pthread to start up here yet.
      // (A single Worker can also host multiple pthreads throughout its lifetime, shutting down a pthread will not shut down its hosting Worker,
      // but the Worker is reused for later spawned pthreads). The 'run' stage below will actually start running a pthread.
      // The stack space for a pthread is allocated and deallocated when a pthread is actually run, not yet at Worker 'load' stage.
      // However, the WebAssembly module we are loading up here has import fields for STACKTOP and STACK_MAX, which it needs to get filled in
      // immediately at Wasm Module instantiation time. The values of these will not get used until pthread is actually running some code, so
      // we'll proceed to set up temporary invalid values for these fields for import purposes. Then whenever a pthread is launched at 'run' stage
      // below, these values are rewritten to establish proper stack area for the particular pthread.
      Module['STACK_MAX'] = Module['STACKTOP']  = 0x7FFFFFFF;

      // Module and memory were sent from main thread
      Module['wasmModule'] = wasmModule = e.data.wasmModule;
      Module['wasmMemory'] = wasmMemory = e.data.wasmMemory;
      Module['buffer'] = buffer = Module['wasmMemory'].buffer;

      Module['PthreadWorkerInit'] = PthreadWorkerInit = e.data.PthreadWorkerInit;
      Module['ENVIRONMENT_IS_PTHREAD'] = true;

      if (typeof e.data.urlOrBlob === 'string') {
        importScripts(e.data.urlOrBlob);
      } else {
        var objectUrl = URL.createObjectURL(e.data.urlOrBlob);
        importScripts(objectUrl);
        URL.revokeObjectURL(objectUrl);
      }
      Module = cv(Module);
      PThread = Module['PThread'];
      HEAPU32 = Module['HEAPU32'];

      if (typeof FS !== 'undefined' && typeof FS.createStandardStreams === 'function') FS.createStandardStreams();
      postMessage({ cmd: 'loaded' });
    } else if (e.data.cmd === 'objectTransfer') {
      PThread.receiveObjectTransfer(e.data);
    } else if (e.data.cmd === 'run') { // This worker was idle, and now should start executing its pthread entry point.
      __performance_now_clock_drift = performance.now() - e.data.time; // Sync up to the clock of the main thread.
      threadInfoStruct = e.data.threadInfoStruct;
      Module['__register_pthread_ptr'](threadInfoStruct, /*isMainBrowserThread=*/0, /*isMainRuntimeThread=*/0); // Pass the thread address inside the asm.js scope to store it for fast access that avoids the need for a FFI out.
      selfThreadId = e.data.selfThreadId;
      parentThreadId = e.data.parentThreadId;
      // Establish the stack frame for this thread in global scope
      // The stack grows downwards
      var max = e.data.stackBase;
      var top = e.data.stackBase + e.data.stackSize;
      Module['STACK_BASE'] = STACK_BASE = top;
      Module['STACKTOP'] = STACKTOP = top;
      Module['STACK_MAX'] = STACK_MAX = max;
      // Call inside asm.js/wasm module to set up the stack frame for this pthread in asm.js/wasm module scope
      Module['establishStackSpace'](e.data.stackBase, e.data.stackBase + e.data.stackSize);
      // Also call inside JS module to set up the stack frame for this pthread in JS module scope
      Module['establishStackSpaceInJsModule'](e.data.stackBase, e.data.stackBase + e.data.stackSize);
      Module['_emscripten_tls_init']();

      PThread.receiveObjectTransfer(e.data);
      PThread.setThreadStatus(Module['_pthread_self'](), 1/*EM_THREAD_STATUS_RUNNING*/);

      try {
        // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
        // Native codebases sometimes spawn threads with other thread entry point signatures,
        // such as void ThreadMain(void *arg), void *ThreadMain(), or void ThreadMain().
        // That is not acceptable per C/C++ specification, but x86 compiler ABI extensions
        // enable that to work. If you find the following line to crash, either change the signature
        // to "proper" void *ThreadMain(void *arg) form, or try linking with the Emscripten linker
        // flag -s EMULATE_FUNCTION_POINTER_CASTS=1 to add in emulation for this x86 ABI extension.
        var result = Module['dynCall_ii'](e.data.start_routine, e.data.arg);


      } catch(e) {
        if (e === 'Canceled!') {
          PThread.threadCancel();
          return;
        } else if (e === 'SimulateInfiniteLoop' || e === 'pthread_exit') {
          return;
        } else {
          Atomics.store(HEAPU32, (threadInfoStruct + 4 /*C_STRUCTS.pthread.threadExitCode*/ ) >> 2, (e instanceof Module['ExitStatus']) ? e.status : -2 /*A custom entry specific to Emscripten denoting that the thread crashed.*/);
          Atomics.store(HEAPU32, (threadInfoStruct + 0 /*C_STRUCTS.pthread.threadStatus*/ ) >> 2, 1); // Mark the thread as no longer running.
          Module['_emscripten_futex_wake'](threadInfoStruct + 0 /*C_STRUCTS.pthread.threadStatus*/, 0x7FFFFFFF/*INT_MAX*/); // Wake all threads waiting on this thread to finish.
          if (!(e instanceof Module['ExitStatus'])) throw e;
        }
      }
      // The thread might have finished without calling pthread_exit(). If so, then perform the exit operation ourselves.
      // (This is a no-op if explicit pthread_exit() had been called prior.)
      if (!noExitRuntime) PThread.threadExit(result);
    } else if (e.data.cmd === 'cancel') { // Main thread is asking for a pthread_cancel() on this thread.
      if (threadInfoStruct && PThread.thisThreadCancelState == 0/*PTHREAD_CANCEL_ENABLE*/) {
        PThread.threadCancel();
      }
    } else if (e.data.target === 'setimmediate') {
      // no-op
    } else if (e.data.cmd === 'processThreadQueue') {
      if (threadInfoStruct) { // If this thread is actually running?
        Module['_emscripten_current_thread_process_queued_calls']();
      }
    } else {
      err('worker.js received unknown command ' + e.data.cmd);
      console.error(e.data);
    }
  } catch(e) {
    console.error('worker.js onmessage() captured an uncaught exception: ' + e);
    console.error(e.stack);
    throw e;
  }
};


