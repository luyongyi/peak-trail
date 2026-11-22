"""Export the playable Airport terminal as a roofless, self-contained GLB."""
import argparse
import collections
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from UnityPy.classes import PPtr
from UnityPy.helpers.MeshHelper import MeshHandler

from build_maps import Scene, pid, vec
from export_meshes import GlbBuilder, material_color_metadata, stored_color_to_linear

SCENE_SHA = "f1228b42b888d4db681c65eb4f9f6566f1f56589632488eb12a040ced767f3bd"
MAIN = "Map/BL_Airport/Main Meshes/Airport"
CARPET = "Map/BL_Airport/Main Meshes/Carpet"
MAIN_CHUNK = MAIN + "/Splitmesh "
CARPET_CHUNK = CARPET + "/Splitmesh "
STRUCTURE = "Map/BL_Airport/Main Meshes/"
PRACTICE_WALL = "Map/Climbing Wall/Climbing wall"
PRACTICE_MATS = "Map/Climbing Wall/Mat/"
# The lobby floor is Y=0.51. Its tall wall primitives share submeshes with
# the upper shell, so slice triangles at the cut height rather than dropping
# entire crossing walls. Lower foundations and the airfield are out of view.
BASE, CUT = -1.35, 3.65
# Southernmost terminal entrance in the source. An off-building row of chairs
# in the airfield has the very same prefab name as indoor seating.
ENTRANCE_Z = 48.79
ATLAS_X = (-40., 48.)
ATLAS_Z = (44., 152.)
ATLAS_SIZE = (1408, 1728)
# Camera Y 3.71 minus its 2.62 m near plane in the Unity floor capture.
ATLAS_MAX_Y = 1.09
MAT_X = (-1., 15.)
MAT_Z = (60., 77.)


def retained(path):
    if path.startswith("Map/BL_Airport/Elevator") and "/Door " in path:
        return True
    if path.startswith((MAIN_CHUNK, CARPET_CHUNK)) or path in ("Court", STRUCTURE + "Desk", STRUCTURE + "Cube",
                                STRUCTURE + "Cube (1)", STRUCTURE + "Outside grid",
                                "Chess/Plane", STRUCTURE + "Windows", PRACTICE_WALL):
        return True
    return path.startswith(("Map/BL_Airport/Seats/", "Map/BL_Airport/Fences/", "Map/BL_Airport/Conveyor (",
                            "Map/BL_Airport/Misc/", "Map/BL_Airport/Displays/", "Map/stanchion", "Map/Sliding Doors", "Map/Flight Board",
                            "Map/Boarding Sign", "Map/Photobooth/Kiosk", PRACTICE_MATS))


def clip_axis(triangles, axis, boundary, keep_above):
    """Clip position, normal and UV together, preserving winding and material."""
    if not len(triangles):
        return triangles
    inside = triangles[:, :, axis] >= boundary if keep_above else triangles[:, :, axis] <= boundary
    whole = inside.all(axis=1)
    parts = [triangles[whole]]
    cut = []
    for tri, mask in zip(triangles[~whole & inside.any(axis=1)], inside[~whole & inside.any(axis=1)]):
        poly = []
        for i, b in enumerate(tri):
            a = tri[i-1]
            if mask[i-1] != mask[i]:
                poly.append(a + (b - a) * ((boundary-a[axis]) / (b[axis]-a[axis])))
            if mask[i]:
                poly.append(b)
        for i in range(1, len(poly)-1):
            cut.append([poly[0], poly[i], poly[i+1]])
    if cut:
        parts.append(np.asarray(cut))
    return np.concatenate(parts)


class AirportGlb(GlbBuilder):
    def add_native_surface(self, atlas, name, span_x, span_z):
        # Unity rendered this ortho texture with the game's shader variants,
        # source vertex masks, texture layers and lighting. Keep the rendered
        # colour independent of the lighting on the surrounding GLB geometry.
        with Image.open(atlas) as source:
            if source.size != ATLAS_SIZE:
                raise ValueError(f"Expected native XZ projection {ATLAS_SIZE}, got {source.size}")
            pixels_per_meter = ATLAS_SIZE[0] / (ATLAS_X[1] - ATLAS_X[0])
            bounds = ((span_x[0] - ATLAS_X[0]) * pixels_per_meter, (ATLAS_Z[1] - span_z[1]) * pixels_per_meter,
                      (span_x[1] - ATLAS_X[0]) * pixels_per_meter, (ATLAS_Z[1] - span_z[0]) * pixels_per_meter)
            encoded = io.BytesIO()
            source.crop(tuple(map(int, bounds))).convert("RGB").save(encoded, format="JPEG", quality=95, subsampling=0, optimize=True)
        self.gltf["extensionsUsed"] = ["KHR_materials_unlit"]
        sampler = len(self.gltf["samplers"])
        self.gltf["samplers"].append({"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071})
        texture = len(self.gltf["textures"])
        self.gltf["textures"].append({"source": len(self.gltf["images"]), "sampler": sampler})
        self.gltf["images"].append({"name": name, "bufferView": self.buffer_view(encoded.getvalue()),
                                    "mimeType": "image/jpeg"})
        index = len(self.gltf["materials"])
        self.gltf["materials"].append({"name": name, "extensions": {"KHR_materials_unlit": {}},
              "pbrMetallicRoughness": {"baseColorTexture": {"index": texture}, "metallicFactor": 0., "roughnessFactor": 1.},
              "extras": {"source": "Unity W/Peak_Standard", "viewportWorldX": span_x, "viewportWorldZ": span_z,
                         "sourcePngSha256": hashlib.sha256(atlas.read_bytes()).hexdigest()}})
        return index

    def map_material(self, ptr):
        key = (ptr["m_FileID"], pid(ptr))
        if key in self.material_ids:
            return self.material_ids[key]
        mat = self.scene.ptr(ptr)
        source = mat.read_typetree()
        props = source["m_SavedProperties"]
        colors, textures, floats = (dict(props.get(k, [])) for k in ("m_Colors", "m_TexEnvs", "m_Floats"))
        shader = material_color_metadata(self.scene, ptr, source)
        # Static albedo approximation of the original shader. Keep the first
        # authored layer of layered materials and its tint/texture projection.
        slot = next((name for name in ("_BaseTexture", "_Texture1", "_BaseMap", "_MainTex")
                     if name in textures and pid(textures[name]["m_Texture"])), None)
        base = shader["baseProperty"]
        rgb = stored_color_to_linear(vec(colors[base], "rgb"), shader["baseFlags"]) if base in colors else np.ones(3)
        if slot == "_Texture1" and shader["shader"] == "W/Peak_Standard":
            # The layer is a partial tint. In this shader _BaseColor, _Tint
            # and _Color1 are all HDR properties already stored in linear RGB.
            # Baking the low blue component as sRGB a second time crushes the
            # seats/trim, while treating the layer as solid obscures the floor.
            base_rgb = vec(colors["_BaseColor"], "rgb")
            layer = colors["_Color1"]
            strength = np.clip(layer["a"], 0., 1.)
            rgb = rgb * ((1. - strength) * base_rgb + strength * vec(layer, "rgb"))
        glass = "glass" in source["m_Name"].lower()
        alpha = colors.get("_BaseColor", {}).get("a", 1.0) if glass else 1.
        rgb = np.clip(rgb, 0, 1)
        pbr = {"baseColorFactor": [*rgb, alpha], "metallicFactor": 0., "roughnessFactor": .9}
        desc = {"name": source["m_Name"], "pbrMetallicRoughness": pbr, "doubleSided": True}
        if glass:
            desc["alphaMode"] = "BLEND"
        scale, offset = np.ones(2), np.zeros(2)
        if slot and not glass:
            tex = textures[slot]
            ref = tex["m_Texture"]
            image_ptr = PPtr(m_FileID=ref["m_FileID"], m_PathID=pid(ref), assetsfile=mat.deref().assets_file)
            resource = image_ptr.deref()
            image_key = (resource.assets_file.name, resource.path_id)
            if resource.type.name == "Texture2D" and image_key not in self.image_ids:
                img = resource.read().image.convert("RGB")
                img.thumbnail((192, 192), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                img.save(output, format="JPEG", quality=84, optimize=True)
                i = len(self.gltf["images"])
                self.gltf["images"].append({"name": resource.read().m_Name, "bufferView": self.buffer_view(output.getvalue()),
                                            "mimeType": "image/jpeg"})
                self.gltf["textures"].append({"source": i, "sampler": 0})
                self.image_ids[image_key] = i
            if image_key in self.image_ids:
                pbr["baseColorTexture"] = {"index": self.image_ids[image_key]}
            scale, offset = vec(tex["m_Scale"], "xy"), vec(tex["m_Offset"], "xy")
        projected = bool(slot == "_Texture1" and floats.get("_Triplanar1On"))
        if projected:
            scale /= max(floats.get("_UV1", 1.), .01)
        record = (len(self.gltf["materials"]), projected, scale, offset, floats.get("_VertexColorAmount", 0.))
        self.gltf["materials"].append(desc)
        self.material_ids[key] = record
        return record


def export(data, output, native_floor, native_mats):
    path = data / "level3"
    if hashlib.sha256(path.read_bytes()).hexdigest() != SCENE_SHA:
        raise ValueError("Unverified Airport scene")
    s = Scene(path, data.parent, static_only=True)
    b = AirportGlb(s)
    b.gltf.pop("extensionsUsed")
    floor_material = b.add_native_surface(native_floor, "Airport native floor", ATLAS_X, ATLAS_Z)
    mat_material = b.add_native_surface(native_mats, "Airport native climbing mats", MAT_X, MAT_Z)
    b.gltf["asset"]["extras"].update({"gameBuildId": "26542162", "sceneName": "Airport", "sourceSceneSha256": SCENE_SHA,
                                     "buildingCutHeight": CUT})
    grouped = collections.defaultdict(list)
    metadata, paths, normals = collections.Counter(), {}, {}

    def active_path(go_id):
        if go_id not in paths:
            go = s.read(go_id)
            parent = pid(s.read(s.transform(go_id))["m_Father"])
            prefix = active_path(pid(s.read(parent)["m_GameObject"])) if parent else ""
            paths[go_id] = (prefix + "/" if prefix else "") + go["m_Name"] if prefix is not None and go["m_IsActive"] else None
        return paths[go_id]

    for obj in s.objects.values():
        if obj.type.name != "GameObject":
            continue
        name = active_path(obj.path_id)
        if not name or not retained(name):
            continue
        comp = {s.objects[pid(c["component"])].type.name: pid(c["component"]) for c in s.read(obj.path_id)["m_Component"]}
        if "MeshRenderer" not in comp or "MeshFilter" not in comp:
            continue
        mr = s.read(comp["MeshRenderer"])
        if not mr["m_Enabled"] or mr["m_CastShadows"] == 3:
            continue
        ptr = s.read(comp["MeshFilter"])["m_Mesh"]
        if not pid(ptr):
            continue
        verts, faces, uv, color, _ = s.mesh(ptr)
        batch = mr.get("m_StaticBatchInfo", {})
        world = s.world(pid(mr["m_StaticBatchRoot"]) if batch.get("subMeshCount") else s.transform(obj.path_id))
        v = verts @ world[:3, :3].T + world[:3, 3]
        if "/Seats/" in name and not batch.get("subMeshCount") and np.mean(v[:, 2]) < ENTRANCE_Z:
            continue
        mesh_key = (ptr["m_FileID"], pid(ptr))
        if mesh_key not in normals:
            reader = MeshHandler(s.ptr(ptr).read()); reader.process()
            if reader.m_Normals:
                normals[mesh_key] = np.asarray(reader.m_Normals, dtype=float)[:, :3]
            else:
                generated = np.zeros_like(verts)
                for sub in faces:
                    face_norm = np.cross(verts[sub[:, 1]] - verts[sub[:, 0]], verts[sub[:, 2]] - verts[sub[:, 0]])
                    for corner in range(3):
                        np.add.at(generated, sub[:, corner], face_norm)
                normals[mesh_key] = generated
        n = normals[mesh_key] @ np.linalg.inv(world[:3, :3])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        first = batch.get("firstSubMesh", 0) if batch.get("subMeshCount") else 0
        count = batch.get("subMeshCount") or len(faces)
        for i, face in enumerate(faces[first:first+count]):
            if not len(face):
                continue
            mat, projected, scale, offset, vertex_strength = b.map_material(mr["m_Materials"][min(i, len(mr["m_Materials"])-1)])
            if np.linalg.det(world[:3, :3]) < 0:
                face = face[:, [0, 2, 1]]
            p, tex = v[face], uv[face].copy()
            if projected:
                axis = np.abs(np.cross(p[:, 1]-p[:, 0], p[:, 2]-p[:, 0])).argmax(axis=1)
                for direction, dims in enumerate(((2, 1), (0, 2), (0, 1))):
                    tex[axis == direction] = p[axis == direction][:, :, dims]
            tex = tex * scale + offset
            tex[:, :, 1] = 1 - tex[:, :, 1]
            # Neutral vertex colours on the terminal encode baked shading.
            # Coloured channels elsewhere are Unity layer masks, not pigment.
            rgb = np.ones((len(verts), 3))
            holds = name == PRACTICE_WALL and b.gltf["materials"][mat]["name"] == "Climbing Holds"
            if holds and vertex_strength:
                rgb = 1. - vertex_strength * (1. - color[:, :3])
            elif vertex_strength and np.max(np.ptp(color[:, :3], axis=1)) < .015:
                rgb[:] = 1. - vertex_strength * (1. - color[:, :1])
            tris = np.concatenate((p, n[face], tex, rgb[face]), axis=2)
            # Furniture at floor level can extend above the sliced wall. High
            # overhead signs and lights must not become a new roof.
            high = CUT if name.startswith(STRUCTURE) and not name.endswith("/Desk") else 5.7
            tris = clip_axis(tris, 1, BASE, True)
            if name != PRACTICE_WALL:
                tris = clip_axis(tris, 1, high, False)
            if name.startswith(CARPET_CHUNK) or name == STRUCTURE + "Outside grid":
                # Both meshes extend into backstage areas behind the entrance.
                tris = clip_axis(tris, 2, ENTRANCE_Z, True)
            is_mat = name.startswith(PRACTICE_MATS)
            if len(tris) and (is_mat or name.startswith((MAIN_CHUNK, CARPET_CHUNK))
                              or name in (STRUCTURE + "Outside grid", "Chess/Plane", "Court")):
                # Apply the overhead projection to the floor and lower grating.
                # Wall tops and the sides of steps keep their own material.
                surface = np.cross(tris[:, 1, :3] - tris[:, 0, :3], tris[:, 2, :3] - tris[:, 0, :3])
                magnitude = np.linalg.norm(surface, axis=1)
                if is_mat:
                    # Capture includes the entire rounded top of each pad.
                    project = surface[:, 1] > .03 * magnitude
                    target_mat, span_x, span_z = mat_material, MAT_X, MAT_Z
                else:
                    project = (surface[:, 1] > .8 * magnitude) & (np.max(tris[:, :, 1], axis=1) < ATLAS_MAX_Y)
                    target_mat, span_x, span_z = floor_material, ATLAS_X, ATLAS_Z
                tops = tris[project]
                if len(tops):
                    tops[:, :, 6] = (tops[:, :, 0] - span_x[0]) / (span_x[1] - span_x[0])
                    tops[:, :, 7] = (span_z[1] - tops[:, :, 2]) / (span_z[1] - span_z[0])
                    tops[:, :, 8:11] = 1.
                    grouped[target_mat].append(tops.reshape(-1, 11))
                    metadata[name] += len(tops)
                tris = tris[~project]
            if len(tris):
                grouped[mat].append(tris.reshape(-1, 11))
                metadata[name] += len(tris)
    if (not any(name.startswith(MAIN_CHUNK) for name in metadata)
            or not any(name.startswith(CARPET_CHUNK) for name in metadata)
            or not grouped[floor_material] or not grouped[mat_material] or PRACTICE_WALL not in metadata
            or not any("/Seats/" in name for name in metadata)):
        raise ValueError("Missing Airport terminal, carpet, native floor or seating")
    primitives = []
    triangle_count = 0
    for mat, batches in grouped.items():
        raw = np.concatenate(batches)
        if b.gltf["materials"][mat]["name"] == "Climbing Holds":
            # The small practice-wall grips consume almost half the original
            # triangles. Pick source vertices at 6 cm resolution on these
            # grips only; keep every other fixture and wall at full resolution.
            _, representatives, remap = np.unique(np.round(raw[:, :3] / .06).astype(np.int32),
                                                   axis=0, return_index=True, return_inverse=True)
            faces = remap.reshape(-1, 3)
            valid = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])
            raw = raw[representatives[faces[valid].ravel()]]
            # Centimetre precision is finer than these cells. Quantize only
            # their position/normal/UV data; retain the authored route colours.
            raw[:, :8] = raw[:, :8].round(2)
        verts, index = np.unique(raw.round(4).astype("float32"), axis=0, return_inverse=True)
        faces = index.reshape(-1, 3)
        area = np.cross(verts[faces[:, 1], :3] - verts[faces[:, 0], :3], verts[faces[:, 2], :3] - verts[faces[:, 0], :3])
        index = faces[np.linalg.norm(area, axis=1) > 1e-9].ravel()
        if not len(index):
            continue
        norm = verts[:, 3:6]
        norm /= np.maximum(np.linalg.norm(norm, axis=1, keepdims=True), 1e-12)
        attrs = {"POSITION": b.accessor(verts[:, :3], "VEC3", target=34962, bounds=True),
                 "NORMAL": b.accessor(norm, "VEC3", target=34962)}
        if "baseColorTexture" in b.gltf["materials"][mat]["pbrMetallicRoughness"]:
            attrs["TEXCOORD_0"] = b.accessor(verts[:, 6:8], "VEC2", target=34962)
        if np.any(verts[:, 8:11] < .999):
            rgba = np.ones((len(verts), 4))
            rgba[:, :3] = verts[:, 8:11]
            attrs["COLOR_0"] = b.accessor(np.round(np.clip(rgba, 0, 1) * 255), "VEC4", 5121, target=34962)
            b.gltf["accessors"][attrs["COLOR_0"]]["normalized"] = True
        primitives.append({"attributes": attrs, "material": mat, "indices": b.accessor(index.ravel(), "SCALAR",
                           5123 if len(verts) <= 65535 else 5125, target=34963)})
        b.min_world = np.minimum(b.min_world, verts[:, :3].min(0)); b.max_world = np.maximum(b.max_world, verts[:, :3].max(0))
        triangle_count += len(index) // 3
    b.gltf["meshes"].append({"name": "Roofless Airport", "primitives": primitives})
    b.add_node({"name": "Airport", "mesh": 0})
    output.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps({**b.write(output), "drawGroups": len(primitives), "triangles": triangle_count}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path, help="Installed PEAK_Data directory")
    parser.add_argument("output", type=Path, help="Destination GLB")
    parser.add_argument("--native-floor", type=Path, required=True,
                        help="1408×1728 orthographic Unity floor render, world X [-40,48] → right, Z [44,152] → up")
    parser.add_argument("--native-mats", type=Path, required=True,
                        help="Matching full-frame Unity capture of the nine climbing mats, including their upper surface")
    args = parser.parse_args()
    export(args.data, args.output, args.native_floor, args.native_mats)
