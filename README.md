# @dsh-external/dsh-shared-room

与具体业务无关的多代理共享事件房间。它让每个 session 只读取自己尚未确认的新增事件，不需要协调者分别维护上下文增量。

`shared_room` 有五个动作：

- `create`：零参数创建随机房间；当前 session 自动成为唯一 owner 和首位参与者。
- `join(roomId)`：注册当前 session；重复调用无副作用。
- `say(roomId, text)`：已注册 session 发言，不移动该 session 的读取浮标。
- `check(roomId)`：返回当前 session 尚未确认的事件，追加一条对其他成员可见的 `check` 事件，并把自己的浮标推进越过该事件。
- `kick(roomId, targetSessionId)`：owner 移除已废弃的非 owner session，避免它永久阻塞全员确认。

`shared_room_state` 管理独立于公共消息流的成员状态：

- `set(roomId, key, value)`：已注册成员更新自己的一个 JSON 值；覆盖即可，没有单独的删除动作。`profile.name` 是昵称约定，更新后每条公共事件都会同时携带稳定的 `sessionId` 和新 `displayName`。
- `get(roomId, targetSessionId?)`：仅 owner 查询一个当前成员；省略目标时查询 owner 自己。
- `list(roomId)`：仅 owner 查询所有当前成员及其完整状态。

状态查询不追加事件、不移动读取浮标。状态变更写入同一持久日志以便重建，但不会出现在成员的 `shared_room check` 结果中；子代理需要了解主持状态时，应当直接询问 owner。昵称只影响展示，权限和成员身份始终使用 session id。成员被踢出时其状态随成员席位清除，重新加入后从空状态开始。

每个房间是一个格式化文本追加日志。`join / say / check / kick` 是参与者可见事件，`set` 是仅供持久化和 owner 查询投影使用的状态事件；它们统一采用 `session-id 动作 可选对象` 的主谓宾格式。事件序号由日志位置派生，不重复写入。加载时从头重放即可重建成员、昵称、KV、读取浮标、待投递事件以及实际读写顺序。`say` 的每一行正文统一缩进；`set` 的 JSON 值写在单独的缩进行，因此正文或字符串中的换行和事件关键字不会被解释成控制事件。

所有当前参与者都越过后，事件会从重建出的可投递缓冲中回收；原始事件仍留在追加日志中，所以插件重载或 Web 重启后房间可以继续。一次 `check` 不会向调用者回显它自己的 `check` 事件，但其他 session 可以看到它。

读写调度由协调者决定。让每个 session 先 `check` 再 `say`，后行动者可以看到前序事件，适合轮流发言；让所有 session 先 `say` 再统一 `check`，本轮写入时彼此不可见，适合石头剪刀布一类同步决策。

房间不认识游戏、模型、角色、裁决或私聊。KV 键也没有内置游戏含义，只有 `profile.name` 影响通用事件展示。除创建者自动注册外，其他 session 必须先 `join`；owner 席位唯一且不可踢出或转让。

## 配置

```yaml
config:
  roomsDir: /path/to/shared-rooms
```

默认目录是 `~/.dsh/storages/dsh-shared-room/rooms`。

## 构建与验证

```bash
DSH_CHECKOUT=/root/deepseek-harness npm test
```

构建后可通过普通 profile 安装，不需要 `super-injector`：

```bash
cd /path/to/deepseek-harness
DSH_HOME=<home> pnpm dsh plugin --profile web add /root/dsh-shared-room
```
