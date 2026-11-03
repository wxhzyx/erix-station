<script setup lang="ts">
import { ElButton, ElCard, ElDescriptions, ElDescriptionsItem, ElTag } from 'element-plus';
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
      <header class="station-header"><div><span class="page-eyebrow">WORKSPACE / PREFERENCES</span><h1>{{ en ? 'Personal settings' : '个人设置' }}</h1></div><ElButton @click="logout">{{ t('common.logout') }}</ElButton></header>
      <main class="console-content personal-settings">
        <nav class="section-tabs" :aria-label="en ? 'Settings sections' : '设置分类'">
          <router-link to="/settings" :class="{ active: !usage }">{{ en ? 'Profile & preferences' : '账号与偏好' }}</router-link>
          <router-link to="/settings?tab=usage" :class="{ active: usage }">{{ en ? 'Usage & quota' : '用量与额度' }}</router-link>
        </nav>
        <TokenQuotaPanel v-if="usage" embedded />
        <template v-else>
          <ElCard shadow="never"><template #header><div class="card-heading"><h2>{{ en ? 'Account' : '账号信息' }}</h2><ElTag>{{ auth.user?.auth_source === 'oidc' ? 'INTEVA SSO' : (en ? 'Platform account' : '平台账号') }}</ElTag></div></template>
            <ElDescriptions :column="1" border><ElDescriptionsItem :label="en ? 'Name' : '显示名称'">{{ auth.user?.display_name || auth.user?.login }}</ElDescriptionsItem><ElDescriptionsItem :label="en ? 'Account' : '登录账号'">{{ auth.user?.login }}</ElDescriptionsItem><ElDescriptionsItem :label="en ? 'Role' : '角色'">{{ auth.user?.role === 'admin' ? (en ? 'Administrator' : '管理员') : (en ? 'Member' : '成员') }}</ElDescriptionsItem></ElDescriptions>
          </ElCard>
          <ElCard shadow="never"><div class="setting-row"><strong>{{ en ? 'Language' : '界面语言' }}</strong><LocaleSwitch /></div></ElCard>
          <section class="console-note"><strong>{{ en ? 'Models are managed centrally' : '模型由管理员统一配置' }}</strong><p>{{ en ? 'API connections and model assignments are managed in the admin console. Contact your administrator to change access.' : 'API 接入、模型分配和权限由管理员统一管理。如需调整，请联系管理员。' }}</p><router-link v-if="auth.user?.role === 'admin'" to="/admin/llm">{{ en ? 'Open API & models →' : '前往 API 与模型 →' }}</router-link></section>
        </template>
      </main>
    </div>
  </StationShell>
</template>
