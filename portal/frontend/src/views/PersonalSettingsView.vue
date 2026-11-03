<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import StationShell from '../components/StationShell.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import TokenQuotaPanel from '../components/TokenQuotaPanel.vue';
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { locale, t } = useI18n();
const en = computed(() => locale.value === 'en');
const usage = computed(() => route.query.tab === 'usage');
async function logout() { await auth.logout(); await router.replace('/login'); }
</script>
<template>
  <StationShell area="settings">
    <div class="station-settings console-page">
      <header class="station-header"><div><span class="page-eyebrow">WORKSPACE / PREFERENCES</span><h1>{{ en ? 'Personal settings' : '个人设置' }}</h1></div><button class="station-secondary" @click="logout">{{ t('common.logout') }}</button></header>
      <main class="console-content personal-settings">
        <div class="page-intro"><h2>{{ en ? 'Your workspace, organized.' : '专注工作，其余交给平台。' }}</h2><p>{{ en ? 'Manage your preferences and daily usage in one place.' : '在这里管理个人偏好、查看用量和申请额度。' }}</p></div>
        <nav class="section-tabs" :aria-label="en ? 'Settings sections' : '设置分类'">
          <router-link to="/settings" :class="{ active: !usage }">{{ en ? 'Profile & preferences' : '账号与偏好' }}</router-link>
          <router-link to="/settings?tab=usage" :class="{ active: usage }">{{ en ? 'Usage & quota' : '用量与额度' }}</router-link>
        </nav>
        <TokenQuotaPanel v-if="usage" embedded />
        <template v-else>
          <section class="console-card"><div class="card-heading"><h2>{{ en ? 'Account' : '账号信息' }}</h2><span class="status-pill">{{ auth.user?.auth_source === 'oidc' ? 'INTEVA SSO' : (en ? 'Platform account' : '平台账号') }}</span></div><dl class="setting-rows"><div><dt>{{ en ? 'Name' : '显示名称' }}</dt><dd>{{ auth.user?.display_name || auth.user?.login }}</dd></div><div><dt>{{ en ? 'Account' : '登录账号' }}</dt><dd>{{ auth.user?.login }}</dd></div><div><dt>{{ en ? 'Role' : '角色' }}</dt><dd>{{ auth.user?.role === 'admin' ? (en ? 'Administrator' : '管理员') : (en ? 'Member' : '成员') }}</dd></div></dl></section>
          <section class="console-card"><h2>{{ en ? 'Preferences' : '使用偏好' }}</h2><div class="setting-row"><div><strong>{{ en ? 'Language' : '界面语言' }}</strong><p>{{ en ? 'Applies to this browser.' : '选择适合你的界面语言，在此浏览器中保留。' }}</p></div><LocaleSwitch /></div></section>
          <section class="console-note"><strong>{{ en ? 'Models are managed centrally' : '模型由管理员统一配置' }}</strong><p>{{ en ? 'API connections and model assignments are managed in the admin console. Contact your administrator to change access.' : 'API 接入、模型分配和权限由管理员统一管理。如需调整，请联系管理员。' }}</p><router-link v-if="auth.user?.role === 'admin'" to="/admin/llm">{{ en ? 'Open API & models →' : '前往 API 与模型 →' }}</router-link></section>
        </template>
      </main>
    </div>
  </StationShell>
</template>
