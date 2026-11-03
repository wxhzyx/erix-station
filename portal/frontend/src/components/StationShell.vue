<script setup lang="ts">
import { ElAvatar, ElIcon, ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus';
import { Grid, ArrowDown } from '@element-plus/icons-vue';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import StationModeSwitch from './StationModeSwitch.vue';
import QuotaIndicator from './QuotaIndicator.vue';
defineProps<{ area: 'chat' | 'work' | 'settings' | 'admin' }>();
const auth = useAuthStore();
const router=useRouter();
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const name = computed(() => auth.user?.display_name || auth.user?.login || '');
async function accountAction(command:string){
  if(command==='logout'){await auth.logout();await router.replace('/login');}
  else await router.push(command==='usage'?'/settings?tab=usage':'/settings');
}
</script>

<template>
  <div class="station-shell">
    <nav class="station-topbar" :aria-label="en ? 'Main navigation' : '主导航'">
      <div class="rail-brand"><span class="brand-mark" aria-hidden="true">F<span>_</span></span><div><strong>FDE Station</strong><small>INTEVA · WORKSPACE</small></div></div>
      <StationModeSwitch :mode="area" />
      <div class="station-utilities">
        <router-link v-if="area !== 'admin'" to="/projects" class="rail-link"><ElIcon><Grid /></ElIcon><span class="full-label">{{en?'Projects':'项目协作'}}</span><span class="compact-label">{{en?'Projects':'项目'}}</span></router-link>
        <router-link v-if="auth.user?.role === 'admin'" to="/admin" class="rail-link" :class="{ active: area === 'admin' }" :aria-current="area === 'admin' ? 'page' : undefined"><ElIcon><Grid /></ElIcon><span class="full-label">{{ en ? 'Admin console' : '管理台' }}</span><span class="compact-label">{{ en ? 'Admin' : '管理' }}</span></router-link>
        <QuotaIndicator v-if="auth.user && (area === 'work' || area === 'chat')" />
        <ElDropdown trigger="click" placement="bottom-end" @command="accountAction">
          <button type="button" class="rail-profile account-trigger" :aria-label="en?'Account menu':'账号菜单'"><ElAvatar :size="30">{{ name.slice(0, 1).toUpperCase() }}</ElAvatar><strong>{{name}}</strong><ElIcon><ArrowDown /></ElIcon></button>
          <template #dropdown><ElDropdownMenu><ElDropdownItem command="settings">{{en?'Personal settings':'个人设置'}}</ElDropdownItem><ElDropdownItem command="usage">{{en?'Usage & quota':'用量与额度'}}</ElDropdownItem><ElDropdownItem command="logout" divided data-testid="account-logout">{{en?'Sign out':'退出登录'}}</ElDropdownItem></ElDropdownMenu></template>
        </ElDropdown>
      </div>
    </nav>
    <div class="station-surface"><slot /></div>
  </div>
</template>
