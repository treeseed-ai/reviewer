import{expect,it}from'vitest';
import * as privacy from '../../../src/verifiers/guarantees/safe-cli-failure.ts';

it('retains an original bounded owner classification or code without reading inherited accessors coercing data or exposing failure prose',()=>{
 const extract=Reflect.get(privacy,'nativeFailureCode') as ((value:unknown)=>string)|undefined;
 expect(typeof extract).toBe('function');if(!extract)return;
 const framework=(cause:unknown)=>Object.assign(new Error('Private framework details'),{code:'ERR_TEST_FAILURE',cause});
 for(const[original,expected]of[
  [{classification:'OWNER_REQUIRES_REVIEW',code:'OWNER_NATIVE_FAILURE'},'OWNER_REQUIRES_REVIEW'],
  [{code:'OWNER_NATIVE_FAILURE'},'OWNER_NATIVE_FAILURE'],
  [{classification:'private\ncredential details',code:'OWNER_NATIVE_FAILURE'},'OWNER_NATIVE_FAILURE'],
  [{classification:'',code:'sk-private-secret-value'},'ERR_TEST_FAILURE'],
  [Object.create({classification:'INHERITED_CLASSIFICATION',code:'INHERITED_CODE'}),'ERR_TEST_FAILURE'],
  [undefined,'ERR_TEST_FAILURE'],[null,'ERR_TEST_FAILURE'],[42,'ERR_TEST_FAILURE'],[[],'ERR_TEST_FAILURE'],
 ]as const){const input=framework(original),held=Object.getOwnPropertyDescriptors(input);expect(extract(input)).toBe(expected);expect(Object.getOwnPropertyDescriptors(input)).toEqual(held);}
 expect(extract({classification:'DIRECT_OWNER_CLASSIFICATION',code:'ERR_TEST_FAILURE'})).toBe('DIRECT_OWNER_CLASSIFICATION');
 for(const value of[undefined,null,false,0,[],{},'Private failure prose'])expect(extract(value)).toBe('test_failed');
 let reads=0;
 for(const field of['classification','code'])for(const value of[undefined,null,false,0,{},[],Symbol('private'),'',' leading','trailing ','private\nsecret','X'.repeat(101),{toString(){reads++;throw new Error('Forbidden coercion');}}]){
  const input=framework({[field]:value});expect(extract(input)).toBe('ERR_TEST_FAILURE');
 }
 for(const field of['classification','code','cause']){const owner=Object.defineProperty(new Error('private original failure'),field,{get(){reads++;throw new Error('Forbidden accessor');}}),input=field==='cause'?Object.assign(owner,{code:'ERR_TEST_FAILURE'}):framework(owner);expect(extract(input)).toBe('ERR_TEST_FAILURE');}
 expect(reads).toBe(0);
});
