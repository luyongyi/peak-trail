# 箱子、固定资源与豚豚崽的地图标记

`data/maps/loot.25306743.json` 与 `data/maps/loot.25739797.json` 为两版各 21 张、
合计 42 个规范地图包提供可按类型筛选的静态地图标记，当前活动版本为
`25739797`。每份数据来自对应地图包本身的原始 Unity 网格及实例变换，不重新
烘焙地形，也不改变地图包 ID。网页使用有限高度的光柱显示所选类型。

## 覆盖范围

| 类型 ID | 显示名称 | 原始网格名称 | 25306743 合计 | 25739797 合计 |
| --- | --- | --- | ---: | ---: |
| `chest-small` | 小型行李箱 | `Luggage_Small` | 1,890 | 1,877 |
| `chest-large` | 大型行李箱 | `Luggage_large` | 805 | 781 |
| `chest-epic` | 珍奇行李箱 | `Epic Luggage` | 275 | 290 |
| `chest-ancient` | 古代行李箱 | `ancient Luggage` | 104 | 117 |
| `chest-trick` | 恶作剧行李箱 | `Luggage_Trick` | 9 | 11 |
| `item-bird-nest` | 鸟蛋巢 | `BirdNest` | 460 | 490 |
| `item-shelf-shroom` | 固定菌台 | `ShelfShroom` | 3,131 | 3,310 |
| `item-piton` | 固定岩钉 | `pickaxe` | 254 | 247 |
| `item-napberry` | 睡眠浆果点 | `Nap Berry` | 66 | 66 |
| `animal-capybara` | 豚豚崽 | `Cube` + `M_Capybara` 材质 | 53 | 53 |

旧版合计 3,083 处箱体模型位置、3,911 处固定资源／设施模型位置和 53 只
豚豚崽，共 7,047 个标记；当前版分别为 3,076、4,113、53，共 7,242 个。
两个版本共 14,289 个标记。一个物理箱体
只产生一个标记；箱盖、提手、卡扣等零件不重复计数。鸟巢、菌台、岩钉与
睡眠浆果点是可识别的地图资源位置，不表示已有玩家采集、使用或触发的状态。

每个版本均有 53 只豚豚崽，逐只标记原始身体模型的位置，覆盖该版本全部
21 张地图：11 张 Alpine 地图各 3 只，10 张 Mesa 地图各 2 只，均属于
第 3 关（segment 2）。
豚豚崽网格的原名是通用的 `Cube`，因此必须同时匹配精确材质
`M_Capybara`；不能把所有 `Cube` 当作动物。Mesa 中使用
`M_Capybara Mirage` 的海市蜃楼模型明确排除，也不把温泉水面当作动物。
匹配后只对该材质对应的 primitive 计算包围盒，保留 GPU 实例变换，
所以一个合并节点中的多只豚豚崽仍各自生成标记。动物标记在 `source`
中额外保存 `materialName: "M_Capybara"` 作为身份依据。

箱体网格只能证明地图中存在对应外观的位置。真正的行李箱、海市蜃楼和
部分诱饵共用箱体网格，静态网格不能区分它们。因此箱子全部使用
`placement: "randomized-candidate"`：标记用于查找地图候选位置，不保证
某次游戏必定出现可开箱子，不推断箱内物品、开箱状态或陷阱触发情况。

固定资源标记使用 `placement: "fixed"`，含义是地图中的固定模型位置。
豚豚崽同样使用 `placement: "fixed"`，代表源地图中的摆放位置，不反映
当前游戏内的交互或成就状态。
`SingleItemSpawner` 等组件运行时生成的散落道具没有进入旧的静态地形导出，
因此此文件不能恢复这些道具，也不推测随机刷新结果。背包模型同时用于
可拾取道具和 Void 场景变体；通用蘑菇网格还可能是装饰或危险物。这些不能
仅凭网格确定用途的对象不会被提升为补给点。

## 身份与坐标

每张地图绑定 `mapPackId`、`sceneName`、`mapSlot`、`sourceSceneSha256`。
每个标记绑定地图层及该层的 `geometrySha256`，保留网格、节点、GPU 实例
索引与原模型原点。导出器在读取前核对规范地图包身份与每个几何文件摘要。
地图层直接决定章节归属，包括不同终局分支与独立的天底层；不按高度猜章节。

位置是对应箱体或资源模型包围盒的世界中心：先应用完整父节点变换，再应用
`EXT_mesh_gpu_instancing` 的平移、旋转、缩放。静态批处理模型的顶点本身可能
已经位于世界坐标，因此不能把节点原点直接当作资源位置。`pos` 始终保存
Unity 原始 XYZ 米制坐标，网页的 Z 轴转换由场景统一执行。

两版 `25306743`、`25739797` 的全部源场景摘要均不同。导出器分别读取各版
21 个规范地图包的 126 份几何文件，逐层验证 SHA-256，再计算该版坐标；
不通过地图槽位或对齐矩阵把某一版坐标复用于另一版。对当前安装游戏的
只读 prefab 的检查仅帮助确认同名模型的用途与歧义：`BirdNest` 位于具有
`BerryBush` 的蛋巢下；`pickaxe` 位于具有 `ClimbHandle` 和 `ShittyPiton` 的
固定岩钉下；`ShelfShroom` 有预放置菌台变体；`Nap Berry` 同时用于物品与
`FakeNapBerry` / `OrbThatMakesYouSleepy` 场景点。所有输出坐标始终来自其
绑定版本的规范几何文件。

豚豚崽的身份也通过只读游戏资源核对：真实 Alpine 温泉和 Mesa Oasis
下的动物具有 `Capybara` 组件，其子模型是 `Cube`、材质为 `M_Capybara`；
同一身体网格有 1,522 个顶点，包围盒与规范地图中的对应模型一致。
`MirageOasis` 则具有 `MirageLuggage`，动物外观使用
`M_Capybara Mirage`，不会进入真实豚豚崽标记。游戏 prefab 提供用途与
模型身份的交叉验证，两份数据共 106 个动物坐标分别从对应版本的规范 GLB
独立计算。

## 重建与验证

从仓库根目录运行：

```powershell
node PeakTrailPlatform/tools/offline-maps/export-loot-from-geometry.mjs --build 25306743
node PeakTrailPlatform/tools/offline-maps/export-loot-from-geometry.mjs --build 25739797
node --test PeakTrailPlatform/web/tests/map-loot-data.test.mjs PeakTrailPlatform/web/tests/loot-geometry-export.test.mjs
node PeakTrailPlatform/tools/stage-site.mjs
```

导出器默认导出目录中的活动版本；`--build` 可显式选择要重建的版本，
`--catalog`、`--packs`、`--output` 可指定对应目录和文件，并直接使用仓库内 Three.js
附带的 Meshopt 解码器，无需安装额外 npm 依赖。仅重建数据需要本机忽略目录
中的原始地图包；CI 的数据验证与合成几何测试不依赖游戏安装或私有资源。

测试检查两版全部 42 张地图的场景和几何摘要、类型与位置覆盖、重复模型去重、
章节归属、父节点与非均匀缩放、静态批处理原点、压缩 GPU 实例，以及损坏
几何数据的拒绝行为。豚豚崽额外验证精确材质匹配、海市蜃楼排除、混合
材质 primitive 不污染动物中心，以及 Alpine／Mesa 的逐图数量。
后续需要增加散落道具时，应从对应版本的原始场景
组件或实际世界遥测导出，保持这种身份约束。
