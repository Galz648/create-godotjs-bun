@tool
extends EditorPlugin

## Polls .godot/GodotJS/**/*.js mtimes. A newer bundle means Bun finished a rebuild.
## GodotJS reloads changed .ts scripts on NOTIFICATION_APPLICATION_FOCUS_IN; this sends that
## notification so the editor does not need real window focus. Method names stay off EditorPlugin
## virtuals (_edit, _handles, _build, ...).

const POLL_SEC := 0.5
const SETTLE_SEC := 0.15

var _poll_timer: Timer
var _settle_timer: Timer
var _seen_mtime: int = -1


func _enter_tree() -> void:
	_poll_timer = Timer.new()
	_poll_timer.wait_time = POLL_SEC
	_poll_timer.timeout.connect(_poll_bundles)
	add_child(_poll_timer)

	_settle_timer = Timer.new()
	_settle_timer.one_shot = true
	_settle_timer.wait_time = SETTLE_SEC
	_settle_timer.timeout.connect(_settle_then_reload)
	add_child(_settle_timer)

	_seen_mtime = _newest_bundle_mtime()
	_poll_timer.start()


func _exit_tree() -> void:
	if _poll_timer != null:
		_poll_timer.queue_free()
		_poll_timer = null
	if _settle_timer != null:
		_settle_timer.queue_free()
		_settle_timer = null


func _poll_bundles() -> void:
	var mtime := _newest_bundle_mtime()
	if mtime == _seen_mtime:
		return
	_seen_mtime = mtime
	# Restart the settle window so a rebuild that writes several files counts once.
	_settle_timer.start()


func _settle_then_reload() -> void:
	var mtime := _newest_bundle_mtime()
	if mtime != _seen_mtime:
		_seen_mtime = mtime
		_settle_timer.start()
		return
	var tree := get_tree()
	if tree == null or tree.root == null:
		return
	tree.root.propagate_notification(MainLoop.NOTIFICATION_APPLICATION_FOCUS_IN)


func _newest_bundle_mtime() -> int:
	return _walk_mtime(ProjectSettings.globalize_path("res://.godot/GodotJS"))


func _walk_mtime(path: String) -> int:
	var newest := 0
	var dir := DirAccess.open(path)
	if dir == null:
		return 0
	for file_name in dir.get_files():
		if not str(file_name).ends_with(".js"):
			continue
		var modified := int(FileAccess.get_modified_time(path.path_join(file_name)))
		if modified > newest:
			newest = modified
	for sub in dir.get_directories():
		var modified := _walk_mtime(path.path_join(sub))
		if modified > newest:
			newest = modified
	return newest
