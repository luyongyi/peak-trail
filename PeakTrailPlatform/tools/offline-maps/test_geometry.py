import unittest
import numpy as np
from build_maps import trs, raster, primitive_mesh
from export_meshes import FOLIAGE_TEXTURE_MAX_SIDE, decompose_exact, foliage_material_contract, source_base_property, stored_color_to_linear

class GeometryTests(unittest.TestCase):
    def test_foliage_delivery_texture_has_a_bounded_documented_size(self):
        self.assertEqual(FOLIAGE_TEXTURE_MAX_SIDE,256)

    def test_source_base_property_uses_authored_foliage_and_ice_color(self):
        colors={'_Tint':object(),'_BaseColor':object(),'_Color':object()}
        self.assertEqual(source_base_property('M_Foliage_Pine','GD/FoliageGD',colors,{}),'_BaseColor')
        self.assertEqual(source_base_property('M_Ice','W/Peak_Ice',colors,{}),'_BaseColor')

    def test_source_base_property_uses_palm_leaf_tint(self):
        colors={'_Tint':object(),'_BaseColor':object(),'_Color':object()}
        self.assertEqual(source_base_property('M_Foliage_Palmtree 5','GD/FoliageGD',colors,{}),'_Tint')
        self.assertEqual(source_base_property('M_Foliage Generic','GD/FoliageGD',colors,{}),'_BaseColor')

    def test_source_base_property_preserves_other_shader_fallbacks(self):
        colors={'_Tint':object(),'_BaseColor':object(),'_Color':object()}
        self.assertEqual(source_base_property('Material','W/Peak_Standard',colors,{}),'_Tint')
        self.assertEqual(source_base_property('Material','W/Peak_Rock',colors,{'_TopColorAmount':1}),'_BaseColor')
        self.assertEqual(source_base_property('Material','Unknown',{'_BaseColor':object()},{}),'_BaseColor')

    def test_foliage_uses_shape_cutout_and_source_culling(self):
        shape={'m_Texture':{'m_FileID':1,'m_PathID':42},'m_Scale':{'x':2,'y':3},'m_Offset':{'x':.1,'y':.2}}
        contract=foliage_material_contract('GD/FoliageGD',{'_Shape':shape,'_Texture1':{}},{'_AlphaClip':.513,'_Cull':2})
        self.assertIs(contract['texture'],shape)
        self.assertEqual(contract['textureProperty'],'_Shape')
        self.assertEqual(contract['alphaCutoff'],.513)
        self.assertFalse(contract['doubleSided'])
        self.assertTrue(foliage_material_contract('GD/FoliageGD',{'_Shape':shape},{'_Cull':0})['doubleSided'])
        vine=foliage_material_contract('W/Vine',{'_Shape':shape},{'_AlphaClip':.478,'_Cull':2})
        self.assertEqual(vine['alphaCutoff'],.478)
        self.assertFalse(vine['doubleSided'])

    def test_foliage_contract_never_guesses_for_other_shaders_or_missing_shape(self):
        shape={'m_Texture':{'m_FileID':1,'m_PathID':42}}
        self.assertIsNone(foliage_material_contract('Unknown/Foliage',{'_Shape':shape},{'_AlphaClip':.5}))
        self.assertIsNone(foliage_material_contract('GD/FoliageGD',{'_Texture1':shape},{'_AlphaClip':.5}))

    def test_hdr_material_is_not_linearized_twice(self):
        value=np.array([.1415094,.1297805,.114142])
        np.testing.assert_array_equal(stored_color_to_linear(value,16),value)
        self.assertLess(stored_color_to_linear(value,0)[0],.02)

    def test_true_shear_retains_full_affine_matrix(self):
        world=np.eye(4); world[0,1]=.02
        self.assertIsNone(decompose_exact(world))
        world=np.diag([2.,3.,4.,1.]); world[:3,3]=[12.,35.,-4.]
        translation,quaternion,scale=decompose_exact(world)
        np.testing.assert_array_equal(translation,[12.,35.,-4.])
        np.testing.assert_array_equal(scale,[2.,3.,4.])
        np.testing.assert_array_equal(quaternion,[0.,0.,0.,1.])

    def test_parent_translation_rotation_and_child_scale(self):
        parent={'m_LocalRotation':dict(zip('xyzw',[0,np.sqrt(.5),0,np.sqrt(.5)])), 'm_LocalPosition':dict(zip('xyz',[10,20,30])), 'm_LocalScale':dict(zip('xyz',[1,1,1]))}
        child={'m_LocalRotation':dict(zip('xyzw',[0,0,0,1])), 'm_LocalPosition':dict(zip('xyz',[2,0,0])), 'm_LocalScale':dict(zip('xyz',[3,2,1]))}
        point=(trs(parent)@trs(child))@np.array([1,1,0,1])
        np.testing.assert_allclose(point,[10,22,25,1],atol=1e-10)

    def test_height_raster_cell_centers_and_topmost_surface(self):
        vertices=np.array([[0,2,0],[2,2,0],[0,2,2]],dtype=float)
        triangles=np.array([[0,1,2]],dtype=np.int32)
        depth=np.full((2,2),-np.inf); rgba=np.zeros((2,2,4),dtype=np.uint8)
        args=[vertices,triangles,np.zeros((3,2)),np.ones((3,4)),np.full((1,1,4),255,dtype=np.uint8),np.ones(4),np.zeros(4),np.array([0.,1.,0.]),np.array([0.,2.,0.,2.]),depth,rgba,False]
        raster(*args)
        self.assertEqual(depth[0,0],2)
        self.assertEqual(depth[1,0],2)
        self.assertTrue(np.isneginf(depth[1,1]))
        vertices[:,1]=1; raster(*args)
        self.assertEqual(depth[0,0],2)

    def test_box_collider_world_center(self):
        world=np.eye(4); world[:3,3]=[10,20,30]
        collider={'m_Center':dict(zip('xyz',[1,2,3])),'m_Size':dict(zip('xyz',[2,4,6]))}
        vertices,*_=primitive_mesh('BoxCollider',collider,world)
        np.testing.assert_allclose(vertices.min(0),[10,20,30])
        np.testing.assert_allclose(vertices.max(0),[12,24,36])

if __name__=='__main__': unittest.main()
