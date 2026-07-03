#!/usr/bin/env python3
"""熊猫桌宠 · 状态采集 hook 脚本。

Claude Code 的 hook 触发本脚本，它把当前会话的状态写成一个文件，供桌宠轮询。

- 从 stdin 读取 hook 事件 JSON，解析事件类型。
- 每个会话一个状态文件，原子写（临时文件 + rename），读方不会读到半个文件。
- 快速返回、绝不阻塞、任何异常都不向 Claude Code 抛错。
- 仅用标准库，在任意 python3 下都能跑，跨平台。
- 只忠实记录「最近一次事件 + 状态 + 时间戳」，不做任何情绪/判断逻辑（那是桌宠的事）。

用法：由 hooks 以 `python3 collector.py <event_name>` 调用，payload 从 stdin 传入。
event_name 也可省略，脚本会回退到 payload 里的 hook_event_name 字段。
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timezone

# 事件 → 熊猫状态 的映射，只取驱动核心状态所必需的最小事件集。
# 事件名以本机 Claude Code 真机触发验证过为准。
EVENT_TO_STATE = {
    "SessionStart": "idle",       # 会话开启，尚无活跃任务 → 待机
    "UserPromptSubmit": "working",  # 用户提交 prompt → 工作中
    "Stop": "done",               # 主 Agent 完成回复 → 完成
    "Notification": "waiting",    # 等待输入 / 请求权限 → 等待输入
}

# 触发文件清理的事件（会话结束）。
CLEANUP_EVENTS = {"SessionEnd"}


def sessions_dir():
    """返回「每 session 一个状态文件」的目录，跨平台，绝不硬编码 ~。

    优先级：显式环境变量 PANDAPET_STATE_DIR（测试/自定义用）> 各平台标准数据目录。
    首版用标准库自行解析平台目录，换取 hook 零第三方依赖、最快启动；展示层
    可另用 platformdirs 等成熟库解析同一路径（约定见 README）。
    """
    override = os.environ.get("PANDAPET_STATE_DIR")
    if override:
        return override

    if sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    elif os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:  # linux / 其它
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(
            os.path.expanduser("~"), ".local", "share"
        )
    return os.path.join(base, "PandaPet", "sessions")


def safe_session_filename(session_id):
    """把 session_id 收敛成安全的文件名片段。"""
    keep = [c if (c.isalnum() or c in "-_") else "_" for c in str(session_id)]
    name = "".join(keep).strip("_") or "unknown"
    return name[:128]


def atomic_write_json(path, data):
    """原子写 JSON：同目录临时文件 + os.replace。"""
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # 原子替换
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main():
    # 读 stdin payload；读不到 / 解析失败都安全降级为空 dict。
    payload = {}
    try:
        raw = sys.stdin.read()
        if raw.strip():
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                payload = {}
    except Exception:
        payload = {}

    # 事件名：优先命令行参数，其次 payload.hook_event_name。
    event = None
    if len(sys.argv) > 1 and sys.argv[1].strip():
        event = sys.argv[1].strip()
    if not event:
        event = payload.get("hook_event_name")

    session_id = payload.get("session_id") or "unknown"

    directory = sessions_dir()
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, safe_session_filename(session_id) + ".json")

    # 会话结束：销毁该 session 的状态文件。
    if event in CLEANUP_EVENTS:
        try:
            os.remove(path)
        except OSError:
            pass
        return

    # 未识别 / 不驱动状态的事件：不改状态，直接返回（克制，不乱写）。
    if event not in EVENT_TO_STATE:
        return

    record = {
        "state": EVENT_TO_STATE[event],
        "active_agents": 0,  # 预留字段；活跃 agent 计数由桌宠聚合多会话时处理
        "last_event": event,
        "updated_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "session_id": session_id,
        # 记录工作目录，便于展示层在提醒里点名「哪个项目」并聚合多会话。
        "cwd": payload.get("cwd") or "",
    }

    # 可选任务简述：仅在提交 prompt 时带一句截断的 prompt，便于展示层碎碎念参考。
    prompt = payload.get("prompt")
    if event == "UserPromptSubmit" and isinstance(prompt, str) and prompt.strip():
        record["message"] = prompt.strip()[:80]

    atomic_write_json(path, record)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 铁律：无论如何都不阻塞、不报错给 Claude Code。
        pass
    sys.exit(0)
