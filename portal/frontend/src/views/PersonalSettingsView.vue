<script setup lang="ts">
import {
  ElCard,
  ElDescriptions,
  ElDescriptionsItem,
  ElTag,
} from "element-plus";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../stores/auth";
import StationShell from "../components/StationShell.vue";
import LocaleSwitch from "../components/LocaleSwitch.vue";
import TokenQuotaPanel from "../components/TokenQuotaPanel.vue";
const auth = useAuthStore();
const route = useRoute();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const usage = computed(() => route.query.tab === "usage");
</script>
<template>
  <StationShell area="settings">
    <div class="personal-page">
      <header class="personal-header">
        <div>
          <h1>{{ en ? "Personal settings" : "个人设置" }}</h1>
        </div>
      </header>
      <main class="personal-content">
        <nav
          class="personal-tabs"
          :aria-label="en ? 'Settings sections' : '设置分类'"
        >
          <router-link to="/settings" :class="{ active: !usage }">{{
            en ? "Profile & preferences" : "账号与偏好"
          }}</router-link>
          <router-link to="/settings?tab=usage" :class="{ active: usage }">{{
            en ? "Usage & quota" : "用量与额度"
          }}</router-link>
        </nav>
        <TokenQuotaPanel v-if="usage" embedded />
        <template v-else>
          <ElCard shadow="never"
            ><template #header
              ><div class="card-heading">
                <h2>{{ en ? "Account" : "账号信息" }}</h2>
                <ElTag>{{
                  auth.user?.auth_source === "oidc"
                    ? "INTEVA SSO"
                    : en
                      ? "Platform account"
                      : "平台账号"
                }}</ElTag>
              </div></template
            >
            <ElDescriptions :column="1" size="large"
              ><ElDescriptionsItem :label="en ? 'Name' : '显示名称'">{{
                auth.user?.display_name || auth.user?.login
              }}</ElDescriptionsItem
              ><ElDescriptionsItem :label="en ? 'Account' : '登录账号'">{{
                auth.user?.login
              }}</ElDescriptionsItem
              ><ElDescriptionsItem :label="en ? 'Role' : '角色'">{{
                auth.user?.role === "admin"
                  ? en
                    ? "Administrator"
                    : "管理员"
                  : en
                    ? "Member"
                    : "成员"
              }}</ElDescriptionsItem></ElDescriptions
            >
          </ElCard>
          <ElCard shadow="never"
            ><div class="setting-row">
              <strong>{{ en ? "Language" : "界面语言" }}</strong
              ><LocaleSwitch /></div
          ></ElCard>
        </template>
      </main>
    </div>
  </StationShell>
</template>

<style scoped>
.personal-page {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: #f7f9fd;
}
.personal-header {
  padding: 36px 48px;
  border-bottom: 1px solid #e7ecf3;
  background: white;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  color: #8a98b0;
  font-weight: 650;
}
.personal-header h1 {
  font-size: 28px;
  font-weight: 700;
  margin: 10px 0 0;
}
.personal-content {
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 36px;
  display: grid;
  gap: 24px;
}
.personal-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid #e1e7f1;
  padding-bottom: 14px;
}
.personal-tabs a {
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 14px;
  color: #7c8aa2;
}
.personal-tabs a.active {
  background: #e9efff;
  color: #365cf5;
  font-weight: 650;
}
.personal-content .el-card {
  border-radius: 18px;
  border-color: #e4eaf3;
}
.card-heading,
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.card-heading h2 {
  font-size: 16px;
  font-weight: 650;
}
.setting-row {
  padding: 8px 0;
}
@media (max-width: 600px) {
  .personal-header {
    padding: 26px 22px;
  }
  .personal-content {
    padding: 22px 16px;
  }
}
</style>
