<script setup lang="ts">
import { ElCard, ElDescriptions, ElDescriptionsItem, ElTag } from 'element-plus';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import StationShell from '../components/StationShell.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import TokenQuotaPanel from '../components/TokenQuotaPanel.vue';
const auth = useAuthStore();
const route = useRoute();
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const usage = computed(() => route.query.tab === 'usage');
</script>
<template>
  <StationShell area="settings">
    <div class="station-settings console-page">
      <header class="station-header"><div><h1>{{ en ? 'Personal settings' : '个人设置' }}</h1></div></header>
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
        </template>
      </main>
    </div>
  </StationShell>
</template>
