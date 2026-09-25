/**
 * A `.wasm` import under the `CompiledWasm` module rule is the compiled module, and
 * is uploaded as its own Worker part (`resvg.wasm`) by Wrangler and by the OpenTofu
 * `files` map.
 */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
