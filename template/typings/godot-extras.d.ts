// Kept beside both the shim and the generated typings.
// Generated `Object.call` only accepts names on the class. GodotJS still constructs with `call("new")`.
// Generated `Signal.connect` takes a Callable. The build plugin wraps a plain function, so scripts may pass one.
declare module "godot" {
  interface Script {
    call(method: "new", ...args: any[]): any;
  }
  interface Signal<T extends (...args: any[]) => void> {
    connect(fn: T, flags?: number): void;
    emit(...args: Parameters<T>): void;
  }
  interface Node {
    get_name(): string;
  }
}
