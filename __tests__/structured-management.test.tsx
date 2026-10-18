import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {Alert,Text,TextInput} from 'react-native';
import {StructuredManagement} from '../src/components/StructuredManagement';
import type {RemoteRequest} from '../src/remote/api';
function button(root:TestRenderer.ReactTestRenderer,label:string){const text=root.root.findAllByType(Text).find(n=>n.props.children===label);let node=text?.parent;while(node&&typeof node.props.onPress!=='function')node=node.parent;if(!node)throw new Error(label);return node}
test('schema management creates and deletes only after local confirmation',async()=>{
 const catalog={schema:[{key:'name',label:'名称',type:'text'}],options:{},items:[{id:'fixture',name:'Fixture',enabled:true}]};
 const rpc=jest.fn(async(_d:string,m:string,p?:Record<string,unknown>)=>m==='management.catalog'?(p?.id?{...catalog,id:'fixture',revision:'revision-fixture',value:{name:'Fixture'}}:catalog):{ok:true});
 const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>undefined);let root!:TestRenderer.ReactTestRenderer;
 await act(async()=>{root=TestRenderer.create(<StructuredManagement desktopId="desktop-management-fixture" request={rpc as RemoteRequest} onChanged={()=>undefined}/>)});
 await act(async()=>button(root,'＋ 新建').props.onPress());
 const id=root.root.findAllByType(TextInput).find(n=>n.props.placeholder==='唯一 ID / 助手代码')!;
 await act(async()=>id.props.onChangeText('new-fixture'));
 await act(async()=>button(root,'保存').props.onPress());
 expect(rpc.mock.calls.some(([,m,p])=>m==='management.mutate'&&p?.operation==='create'&&p?.id==='new-fixture')).toBe(true);
 await act(async()=>button(root,'Fixture').props.onPress());
 await act(async()=>button(root,'删除此项').props.onPress());
 expect(rpc.mock.calls.filter(([,m,p])=>m==='management.mutate'&&p?.operation==='delete')).toHaveLength(0);
 await act(async()=>{await alert.mock.calls[0][2]?.find(b=>b.style==='destructive')?.onPress?.()});
 expect(rpc.mock.calls.some(([,m,p])=>m==='management.mutate'&&p?.confirmed===true&&p?.expectedRevision==='revision-fixture')).toBe(true);
 await act(async()=>root.unmount());alert.mockRestore();
});
