import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {createPinia} from 'pinia';
import {createMemoryHistory,createRouter} from 'vue-router';
import SharedProjectsView from './SharedProjectsView.vue';
import {useAuthStore} from '../stores/auth';
const mounted:ReturnType<typeof mount>[]=[];
afterEach(()=>{for(const w of mounted.splice(0))w.unmount();vi.unstubAllGlobals();});
async function setup(state='invited',showLegacyAuthor=false,embedded=false){
  const calls:{url:string;body?:string}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    calls.push({url,body:options?.body as string});
    const data=url==='/api/collaboration'?{enabled:true,projects:[{id:'p',name:'alpha',state:'active',membership_state:state}]}:
      url.endsWith('/p')?{project:{id:'p',name:'alpha',state:'active',owner_user_id:'a',owner_login:'Owner',owner_name:'负责人',repo_url:'http://git.example/test.git'},mine:{id:'m',user_id:'b',login:'DomainB',branch:'dev/DomainB',state},members:[{id:'m',user_id:'b',login:'DomainB',display_name:'员工 B',branch:'dev/DomainB',state}],can_manage:false,candidates:[]}:
      url.endsWith('/pulls')?{pulls:showLegacyAuthor?[{number:1,title:'交付',user:{login:'sso-old-prefix',station_login:'DomainB',station_display_name:'员工 B'},head:{ref:'dev/DomainB'},merged:true}]:[]}:{ok:true};
    return new Response(JSON.stringify(data),{status:200});
  }));
  const pinia=createPinia(),auth=useAuthStore(pinia);auth.user={id:'b',login:'DomainB',display_name:'员工 B',role:'fde',fde_name:'seat',auth_source:'oidc'};
  const path=embedded?'/admin/projects':'/projects';
  const router=createRouter({history:createMemoryHistory(),routes:[{path,component:SharedProjectsView}]});await router.push(path);await router.isReady();
  const w=mount(SharedProjectsView,{props:{embedded},global:{plugins:[pinia,router],stubs:{StationShell:{template:'<div data-testid="standalone-shell"><slot /></div>'}}}});mounted.push(w);await flushPromises();await vi.waitFor(()=>expect(w.text()).toContain('dev/DomainB'));return {w,calls,router};
}
it('invitation acceptance is explicit and never silently creates a workspace',async()=>{
  const {w,calls}=await setup();expect(calls.filter(x=>x.body)).toHaveLength(0);
  const button=w.findAll('button').find(b=>b.text()==='接受邀请')!;
  await vi.waitFor(()=>expect(button.attributes('disabled')).toBeUndefined());await button.trigger('click');await flushPromises();
  expect(calls.some(c=>c.url==='/api/collaboration/p/members/m/accept')).toBe(true);
});
it('an invited member cannot enter the workbench or submit a PR',async()=>{
  const {w}=await setup();expect(w.text()).not.toContain('进入项目');expect(w.text()).not.toContain('提交合并');
});
it('an active member gets development and explicit synchronization actions',async()=>{
  const {w}=await setup('active');expect(w.text()).toContain('进入项目');expect(w.text()).toContain('同步主分支');expect(w.text()).not.toContain('邀请成员');
});
it('PR authors use SSO names instead of historical Gitea account prefixes',async()=>{
  const {w}=await setup('active',true);
  await w.findAll('[role=tab]').find(tab=>tab.text()==='合并请求')!.trigger('click');
  await flushPromises();
  await vi.waitFor(()=>expect(w.text()).toContain('员工 B · dev/DomainB'));
  expect(w.text()).not.toContain('sso-old-prefix');
});

it('admin project selection stays inside the admin route without nesting another shell',async()=>{
  const {w,router}=await setup('active',false,true);
  expect(w.find('[data-testid="standalone-shell"]').exists()).toBe(false);
  await w.get('.project-tile').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/admin/projects');
  expect(router.currentRoute.value.query.project).toBe('p');
});
