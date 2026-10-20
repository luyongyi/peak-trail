# 箱子、固定资源与水豚的地图标记

`data/maps/loot.25306743.json` 与 `data/maps/loot.25739797.json` 为两版各 21 张、
合计 42 个规范地图包提供可按类型筛选的静态地图标记，当前活动版本为
`25739797`。几何点位来自对应地图包本身的原始 Unity 网格及实例变换；
当前版另从摘要匹配的原始场景组件恢复物品生成点和植物生长点。不重新
烘焙地形，也不改变地图包 ID。网页使用有限高度的光柱显示所选类型，
宝箱与固定物品／设施筛选默认关闭，可按需选择具体类型；水豚标记默认开启。

## 中文显示名称

显示名称统一来自 `data/maps/loot-labels.zh-CN.json`。官方词条读取当前游戏
`resources.assets` 中 path ID 为 `1422` 的运行时 TextAsset
`SerializedTermsData`，简体中文使用 `SimplifiedChinese` 列（索引 `9`）。
物品按游戏原逻辑拼接 `NAME_` 与 `Item.UIData.itemName`，再转为大写查表；
行李箱按 `Luggage.displayName`，固定攀爬设施按 `ClimbHandle.GetName()` 的
`PICKAXE`／`PITONPROMPT` 词条，不直接翻译内部 prefab 或网格名称。

清单的 `kind` 区分官方物品名、官方名称加地图描述、官方说明中的术语及
多物品资源类别。“点”“生成点”“固定”等是地图说明，不是新增的游戏物品名。
例如“行李箱（诱饵外观）”的官方基名只有“行李箱”；“蛋巢（好大蛋／小小蛋）”
汇总两种真实物品；刺莓、莓蕉／菇莓等生长类别也不表示某局固定产出单一物品。
水豚一名来自官方成就说明，未伪造单独的物品名称词条。

未在当前物品 prefab 中找到精确匹配的四个备用别名 `AntiRopeSpool`、
`Coconut`、`HealingRoot`、`PoisonDart` 不进入已认证名称清单；导出器拒绝
未认证别名或按名称前缀推测的译名。这不表示游戏里没有相应类别的道具，
而是不能跳过真实 prefab 的 `UIData` 链路将内部别名认作官方名称。
本次名称同步不调整两版点位坐标、地图包和来源身份；旧版仍使用自身几何坐标。

## 中英语言支持

每个类型在 `types` 中只保存一次中文 `name` 与英文 `nameEn`，点位仍引用稳定的
类型 ID，不在每个 marker 上重复英文名称。英文官方基名读取同一份运行时表的
`English` 列（索引 `0`），与中文词条保留相同来源键；`spawn site`、`growth site`、
`fixed` 及多物品池说明属于网站类别描述，不宣称是游戏内单件物品名称。
章节同样使用官方区域词条，例如 `CALDERA`／火山、`THE CITADEL`／城塞和
`AREA_VOID` 对应的 `NADIR`／天底，不直接展示内部 biome 名作为译名。

网站优先采用有效的 `?lang=en`／`?lang=zh-CN` 选择，其次读取记忆的语言，
未选择时按浏览器语言自动显示中文或英语。显式语言链接和页头切换会记忆选择，
浏览器自动判定本身不会固化为个人设置。切换只更新文字与标记标签，不重新读取
地图或点位数据，也不改变相机、当前分区、类型筛选、标记位置及来源身份。

## 点击靠近与返回

点击模型上的物品、箱子或水豚标记，会平滑靠近其位置并高亮当前标记。
再次点击同一标记，或使用特写卡片上的“返回原视角”，回到第一次靠近前
保存的相机位置、角度及注视点；连续查看其他标记不会覆盖这份返回视角。
类型复选框仍只负责筛选，不会替用户选择其中某一个位置。
近景使用当前已载入模型的三角网格检查遮挡；遇到墙体或顶板时，改选物品
附近较低、较短的可见视角，不隐藏或改写原模型。

拖动或缩放会中断移动动画并交还相机控制，返回入口继续保留。切换地图、
章节或主动选择其他视图后，旧的返回状态会清除；隐藏当前标记时自动返回。
语言切换只更新物品名称和提示。操作不改变点位数据、筛选选择或回放进度；
系统减少动态效果设置下省略相机过渡动画。

## 覆盖范围

下表只统计可从两版规范 GLB 独立认证的几何点位；当前版的场景组件补充另见下节。

| 类型 ID | 显示名称 | 原始网格及必要材质 | 25306743 合计 | 25739797 合计 |
| --- | --- | --- | ---: | ---: |
| `chest-small` | 行李箱 | `Luggage_Small` | 1,890 | 1,877 |
| `chest-large` | 大号行李箱 | `Luggage_large` | 805 | 781 |
| `chest-epic` | 探险家行李箱 | `Epic Luggage` | 275 | 290 |
| `chest-ancient` | 古老行李箱 | `ancient Luggage` | 104 | 117 |
| `chest-trick` | 行李箱（诱饵外观） | `Luggage_Trick` | 9 | 11 |
| `item-bird-nest` | 蛋巢（好大蛋／小小蛋） | `BirdNest` | 460 | 490 |
| `item-shelf-shroom` | 踏板菇（固定） | `ShelfShroom` | 3,131 | 3,310 |
| `item-piton` | 鹤嘴锄（固定） | `pickaxe` | 254 | 247 |
| `item-napberry` | 晚安莓点 | `Nap Berry` | 66 | 66 |
| `item-climbing-spike` | 岩钉（固定） | `Spike` + `M_ClimbingSpike` | 1,411 | 1,319 |
| `item-amulet-bird` | 童军的进取点 | `Medallion_Bird` + `Tarnished Gold Medallion` | 21 | 21 |
| `item-amulet-goat` | 童军的野心点 | `Medallion_Goat` + `Tarnished Gold Medallion` | 21 | 21 |
| `item-amulet-turtle` | 童军的毅力点 | `Medallion_Turtle` + `Tarnished Gold Medallion` | 21 | 21 |
| `item-amulet-bingbong` | 童军的盛情点 | `Medallion_BingBong` + `Tarnished Gold Medallion` | 21 | 21 |
| `animal-capybara` | 水豚 | `Cube` + `M_Capybara` 材质 | 53 | 53 |

旧版几何覆盖 3,083 处箱体模型位置、5,406 处资源／设施参考点和 53 只
水豚；当前版几何覆盖分别为 3,076、5,516、53，场景组件点位在此基础上补充。
当前版另外恢复 38 类、42,585 处场景组件参考点，其中包括 630 处全局物品点
和 21 处终局雕像奖励点。合并后当前版共有 **47 类、48,101 处资源／设施点**，
连同 5 类箱子和水豚，共 **53 类、51,230 个标记**；旧版保持 15 类、
8,542 个几何标记。两个版本合计 59,772 个标记。
一个物理箱体只产生一个标记；箱盖、提手、卡扣等零件不重复计数。
岩钉的 `Ring` 是同一设施的配件，不另行标点。旧版另有 250 个
`Spike` + `M_Rock_ice` 地形变体，未将其误标为岩钉。

固定踏板菇是预放置的攀爬平台，不是可采集食品。两版每版各有 840 处
`ShelfShroom` + `M_Petrified_Stone 1` 位于天底，属于石化踏板菇设施；
森蕈（`Roots`）的 `M_ShelfShroom_Dark` 也属于固定平台。蛋巢、踏板菇、
鹤嘴锄、岩钉与晚安莓点均不表示玩家是否已经采集、使用或触发。

四种护符的静态点位具有 `FakeItem`、`TriggerOnFakeItemPickedUp`、
`SpineCheck` 和 `PropSpawner_AmuletStatues` 的源场景身份，使用
`placement: "randomized-candidate"`，表示护符交互／生成的参考位置。
它们不是终局雕像上的护符展示模型，也不保证某局必定出现可拾取护符。

每个版本均有 53 只水豚，逐只标记原始身体模型的位置，覆盖该版本全部
21 张地图：11 张雪山（`Alpine`）地图各 3 只，10 张方山（`Mesa`）地图各 2 只，均属于
第 3 关（segment 2）。
水豚网格的原名是通用的 `Cube`，因此必须同时匹配精确材质
`M_Capybara`；不能把所有 `Cube` 当作动物。方山（`Mesa`）中使用
`M_Capybara Mirage` 的海市蜃楼模型明确排除，也不把温泉水面当作动物。
匹配后只对该材质对应的 primitive 计算包围盒，保留 GPU 实例变换，
所以一个合并节点中的多只水豚仍各自生成标记。动物标记在 `source`
中额外保存 `materialName: "M_Capybara"` 作为身份依据。

箱体网格只能证明地图中存在对应外观的位置。真正的行李箱、海市蜃楼和
部分诱饵共用箱体网格，静态网格不能区分它们。因此箱子全部使用
`placement: "randomized-candidate"`：标记用于查找地图候选位置，不保证
某次游戏必定出现可开箱子，不推断箱内物品、开箱状态或陷阱触发情况。

其余固定资源／设施几何标记使用 `placement: "fixed"`，含义是地图中的固定模型位置。
水豚同样使用 `placement: "fixed"`，代表源地图中的摆放位置，不反映
当前游戏内的交互或成就状态。

## 场景组件补充与限制

静态地形导出会排除非运动学刚体及其子模型，运行时生成的道具也没有
进入 GLB。因此只扩展网格名称无法找回大部分散落物品和植物果实。
`export_loot_from_scene.py` 只读核验原场景后，从所选地图分区、营火及
`MapHandler.globalParent` 的有效层级中读取 `SingleItemSpawner`、
`EndgameFlareSpawner`、`BerryBush`、`BerryVine`、`GroundPlaceSpawner`、
`Spawner` 和终局 `ScoutStatue` 奖励点。
单道具生成器必须引用经过用途审查且带有物品组件的 prefab；植物／物品池
必须匹配已审查的池类型，并具有有效的启动生成条件与生成位置。
浆果藤的生成位置来自活跃子碰撞体，地面菇类／药用根茎与藤蔓分别核对其真实
`SpawnList` 内容，不把继承字段中的普通物品池误当成它们的生成清单。
这使当前版能够覆盖浆果、椰树、蘑菇等生长点，以及背包、蜂巢、工具等
物品生成参考点，而不把所有同名植物或可生成生物当作补给。

当前版组件数据中的代表性覆盖为：

| 参考点 | 数量 |
| --- | ---: |
| 脆莓生长点 | 3,495 |
| 脆莓／火烧莓生长点 | 2,553 |
| 椰子生长点 | 4,495 |
| 莓蕉／菇莓生长点 | 2,417 |
| 地面采集生成点 | 6,146 |
| 刺莓生长点 | 13,709 |
| 背包生成点 | 84 |
| 蜂巢生成点／蜂巢蜜生成点 | 38／117 |
| 终局雕像奖励点 | 21 |

这些是植株、控制器或奖励锚点的数量，不是预计生成的道具个数。
42,585 处组件点中，2,811 处标记为固定参考锚点，39,774 处保留候选语义。

组件点保存 `componentPathId`、组件类别、prefab 名称（若有）、源场景 SHA-256
及生成条件。普通锚点是生成器／植株控制器的世界位置，不是每枚果子的实时位置。
地面菇类／药用根茎的实际生成还需沿局部向下方向进行地形射线投影，标记只表示
原始生长参考点，不推测本局最终落点。相同类型、同一位置的重复控制器合并
为一个参考点，并在来源中保留各控制器和条件。
玩家数量、攀登条件、普通局限制、启动几率、物品池、数量与重复生成规则仍由
游戏决定。固定的是参考锚点；`fixed` 和 `randomized-candidate` 都不反映本局的
生成、采集或剩余状态。数据不推测随机池最终抽中了哪种物品。

全局物品保留 `scope: "global"`、`segment: -1`、`layerId: "global"` 及
`scopeRoot: "MapHandler.globalParent"`。它们散布在整座山中，没有原生章节
归属，因此不伪造图层或图层几何摘要。全山视图显示这些全局点；单章只显示
落在当前原始图层 XYZ 包围范围内的全局点，作为显示窗口使用，不改变来源
归属。独立天底视图不混入全山物品点。

终局雕像奖励使用 `ScoutStatue.gemSpot` 引用的真实场景 Transform 位置，
而不是雕像根节点原点。来源记录 `anchor: "referenced-transform-world-position"`、
`transformField: "gemSpot"` 和 `transformPathId`。该点先生成奇怪水晶（`Strange Gem`），
集齐四种护符后可在同一位置替换为童军的荣耀（`ScoutsHonor`）；标记保留初始物品与条件奖励
的区别。被关闭的终局绳索事件组件不因存在生成代码就加入物品点位。

当前可读取的原始场景属于 `25739797`，其 21 张地图的源场景摘要均与该版
规范包一致。定向检查 Downloads 下各 Peak 项目、备份和归档及 `.codex`
非会话目录后，未找到可与 `25306743` 摘要匹配的旧版原始场景。
旧版 21 张地图因此只提供独立认证的几何点位，不能宣称已补齐组件物品，
也不会套用当前版的组件坐标。

网格用途有歧义时不扩大资源覆盖：`M_Scallop` 贝壳仅有场景网格／碰撞体，
没有拾取或资源组件；`Cylinder` + `M_ShitStick` 的静态模型属于营火木柴；
天底（`Void`）的背包模型是石化装饰；通用蘑菇还可能是地形或危险物。
这些模型不会仅凭外观变成可拾取补给点。

仓库内的完整审查数据保留可追溯来源；网页发布时将每版完整文件拆为精简的
单地图运行时分片。`data/maps/loot.<build>.json` 是带有地图身份的索引，
每张地图的数据位于 `data/maps/loot/<build>/<mapPackId>.json`。
网页先读取索引，再懒加载当前地图的分片并缓存完整响应，避免一次下载整个版本
的来源记录；取消的请求不污染后续地图选择。

## 身份与坐标

每张地图绑定 `mapPackId`、`sceneName`、`mapSlot`、`sourceSceneSha256`。
图层点位绑定地图层及该层的 `geometrySha256`。几何标记保留网格、节点、GPU 实例
索引与原模型原点；组件标记保留对应源场景的组件身份。全局组件点仅绑定
所属地图和源场景，明确省略没有原生依据的图层摘要。
导出器在读取前核对规范地图包身份与每个几何文件摘要；组件合并还核对版本、
地图、场景摘要与全部图层身份，拒绝跨版本或跨地图的数据。
图层点由地图层直接决定章节归属，包括不同终局分支与独立天底层；
全局点保留独立 scope，不按高度猜章节。

几何位置是对应箱体或资源模型包围盒的世界中心：只统计匹配 primitive 的
索引实际引用顶点，再应用完整父节点变换及
`EXT_mesh_gpu_instancing` 的平移、旋转、缩放。静态批处理模型的顶点本身可能
已经位于世界坐标，共享 POSITION accessor 还可能包含其他模型，不能把
整个 accessor 的包围盒或节点原点直接当作资源位置。组件位置使用
`anchor: "component-world-position"`，终局雕像的 `gemSpot` 引用锚点是上述
明确记录的例外。两种来源的 `pos` 始终保存
Unity 原始 XYZ 米制坐标，网页的 Z 轴转换由场景统一执行。

两版 `25306743`、`25739797` 的全部源场景摘要均不同。导出器分别读取各版
21 个规范地图包的 126 份几何文件，逐层验证 SHA-256，再计算该版坐标；
不通过地图槽位或对齐矩阵把某一版坐标复用于另一版。对当前安装游戏的
只读 prefab 的检查仅帮助确认同名模型的用途与歧义：`BirdNest` 位于具有
`BerryBush` 的蛋巢下；`pickaxe` 位于具有 `ClimbHandle` 和 `ShittyPiton` 的
固定鹤嘴锄下；`Spike` + `M_ClimbingSpike` 属于带有同类攀爬组件的岩钉设施；
`ShelfShroom` 有预放置踏板菇变体；`Nap Berry` 同时用于物品与
`FakeNapBerry` / `OrbThatMakesYouSleepy` 场景点。几何坐标始终来自绑定版本
的规范几何文件，组件坐标只来自摘要匹配的原始场景。

水豚的身份也通过只读游戏资源核对：真实雪山（`Alpine`）温泉和方山绿洲（`Mesa Oasis`）
下的动物具有 `Capybara` 组件，其子模型是 `Cube`、材质为 `M_Capybara`；
同一身体网格有 1,522 个顶点，包围盒与规范地图中的对应模型一致。
`MirageOasis` 则具有 `MirageLuggage`，动物外观使用
`M_Capybara Mirage`，不会进入真实水豚标记。游戏 prefab 提供用途与
模型身份的交叉验证，两份数据共 106 个动物坐标分别从对应版本的规范 GLB
独立计算。

## 重建与验证

从仓库根目录运行。示例使用约定的本地忽略目录；先将变量设为实际的
规范地图包和同版本原始场景目录，不把私有游戏输入写入仓库：

```powershell
$gamePath = 'C:/Program Files (x86)/Steam/steamapps/common/PEAK'
$packsPath = 'local/assets/maps/packs'
$nativeData = 'local/native-inputs/25739797/PEAK_Data'
$sceneLoot = 'local/checks/map-loot/scene-loot.25739797.json'

& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/export_loot_from_scene.py --game $gamePath --data $nativeData --build 25739797 --catalog PeakTrailPlatform/data/maps/catalog.json --packs $packsPath --output $sceneLoot
node PeakTrailPlatform/tools/offline-maps/export-loot-from-geometry.mjs --build 25306743 --packs $packsPath
node PeakTrailPlatform/tools/offline-maps/export-loot-from-geometry.mjs --build 25739797 --packs $packsPath --scene-loot $sceneLoot --compact
& local/python/.venv/Scripts/python.exe -m unittest discover -s PeakTrailPlatform/tools/offline-maps -p test_loot.py
node --test PeakTrailPlatform/web/tests/map-loot-data.test.mjs PeakTrailPlatform/web/tests/loot-geometry-export.test.mjs
node PeakTrailPlatform/tools/stage-site.mjs
```

导出器默认导出目录中的活动版本；`--build` 可显式选择要重建的版本，
`--catalog`、`--packs`、`--output` 可指定对应目录和文件，`--scene-loot` 接收
同版本的场景组件审查产物。省略它会只重建几何点，不能作为当前版的完整发布数据。
`--compact` 只压缩 JSON 排版，保留仓库内的完整来源字段；发布阶段再生成
索引和单地图运行时分片。
几何导出直接使用仓库内 Three.js 附带的 Meshopt 解码器，无需额外 npm 依赖；
组件导出使用离线地图工具的 Python / UnityPy 环境。仅重建需要本机忽略目录中的
游戏输入和地图包；CI 的数据验证与合成测试不依赖游戏安装或私有资源。

测试检查两版全部 42 张地图的场景和几何摘要、类型与位置覆盖、重复模型去重、
章节归属、父节点与非均匀缩放、静态批处理原点、压缩 GPU 实例，以及损坏
几何数据的拒绝行为；新设施额外覆盖材质变体排除、护符候选语义和共享索引
包围盒。水豚额外验证精确材质匹配、海市蜃楼排除、混合材质 primitive
不污染动物中心，以及雪山／方山的逐图数量。组件合并验证每张地图的来源身份，
不能用其他版本或其他地图的数据补位。Python 测试额外覆盖藤蔓碰撞体生成点、
地面生长投影条件、全局 scope、终局奖励引用锚点与重叠控制器去重。

本次完整审查记录位于忽略目录 `local/checks/fixed-items-20261019/`：
`geometry-audit.md`、`geometry-prefab-proof.json`、`geometry-level5-proof.json`、
`amulet-geometry-proof.json`、`old-source-search.json`、`spawner-completeness-review.md`、
`level5-spawn-completeness.json`、`level5-scout-reward-proof.json`；全 42 包的网格／材质清单
为 `geometry-all-mesh-materials.json`。最终组件逐类／逐图汇总为
`scene-loot-summary.25739797.json`，完整全局显示覆盖复核为
`global-display-review.json`。这些记录保留源游戏对象证据，不随网页发布。
