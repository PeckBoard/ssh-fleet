// Wasm interface for the Extism js-pdk compiler (`extism-js`). Declares the
// plugin's exported functions and the host functions Peckboard core provides.
//
// Host functions are JSON-string-in / JSON-string-out at the application level;
// at the ABI they pass a single Extism memory offset (I64) in and return one
// out. See peckboard/src/plugin/host.rs for the host side.
declare module "main" {
  export function manifest(): I32;
  export function init(): I32;
  export function shutdown(): I32;
  export function handle(): I32;
}

declare module "extism:host" {
  interface user {
    peckboard_get_plugin_setting(ptr: I64): I64;
    peckboard_store_put(ptr: I64): I64;
    peckboard_store_get(ptr: I64): I64;
    peckboard_store_list(ptr: I64): I64;
    peckboard_store_delete(ptr: I64): I64;
    peckboard_ssh_probe(ptr: I64): I64;
    peckboard_ssh_exec(ptr: I64): I64;
    peckboard_ssh_read_file(ptr: I64): I64;
    peckboard_ssh_write_file(ptr: I64): I64;
  }
}
