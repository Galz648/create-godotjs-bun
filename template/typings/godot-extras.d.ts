// Kept beside both the shim and the generated typings.
// Generated `Object.call` only accepts names on the class. GodotJS still constructs with `call("new")`.
declare module "godot" {
  interface Script {
    call(method: "new", ...args: any[]): any;
  }
}
