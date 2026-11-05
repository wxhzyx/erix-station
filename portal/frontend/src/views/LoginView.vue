<script setup lang="ts">
import { ElButton, ElInput } from "element-plus";
// 登录页：观感对齐旧 index.html renderLogin() 的 Bootstrap 登录卡（居中卡、品牌绿主按钮、
// 两步切换）。字段/按钮文案/错误展示位置保持逐字等价。
// issue #101 P1：用户可见文案走 i18n（login.*，zh-CN/en 逐字等价），卡片右上角挂语言切换菜单。
// 注意：错误提示 auth.error 来自 auth store（P2 归 errors.*），本阶段保持原样。
import { ref, nextTick, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore, afterLoginRoute } from "../stores/auth";
import LocaleSwitch from "../components/LocaleSwitch.vue";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const ssoEnabled = ref(false);
const passwordEnabled = ref(false);
const providerError = ref(false);
onMounted(async () => {
  try {
    const response = await fetch("/api/auth/providers");
    if (!response.ok) throw new Error("Login providers unavailable");
    const providers = await response.json();
    ssoEnabled.value = providers.sso === true;
    passwordEnabled.value = providers.password !== false;
  } catch {
    providerError.value = true;
  }
});

// 登录守卫携带的 redirect 回跳（如未登录访问 /session/<id> 深链）；仅允许站内路径。
function loginRedirect(): string {
  const r = route.query.redirect;
  return typeof r === "string" && r.startsWith("/")
    ? r
    : afterLoginRoute(auth.user!);
}
const login = ref("");
const password = ref("");
const code = ref("");
const totpInput = ref<HTMLInputElement | null>(null);

async function onLoginSubmit() {
  await auth.login(login.value, password.value);
  if (auth.user) {
    router.replace(loginRedirect());
    return;
  }
  if (auth.pendingToken) {
    // 切第二步后聚焦 TOTP 输入框（旧版 $('totpCode').focus() 等价）。
    await nextTick();
    totpInput.value?.focus();
  }
}

async function onTotpSubmit() {
  await auth.submitTotp(code.value);
  if (auth.user) router.replace(loginRedirect());
}
</script>
<template>
  <div class="auth-page">
    <aside class="auth-story">
      <div class="auth-brand">FDE / Station</div>
      <h1>{{ t("login.title") }}</h1>
      <p>One workspace. Every possibility.</p>
    </aside>
    <main class="auth-stage">
      <section class="auth-card">
        <div class="auth-heading">
          <h2>{{ t("login.title") }}</h2>
          <LocaleSwitch />
        </div>
        <a
          v-if="ssoEnabled && (!passwordEnabled || !auth.pendingToken)"
          href="/api/auth/sso"
          class="sso-button"
          >{{ t("login.sso") }}</a
        >
        <p v-if="route.query.sso_error" role="alert">
          {{ t("login.ssoError") }}
        </p>
        <p v-if="providerError" role="alert">{{ t("login.providerError") }}</p>
        <template v-if="passwordEnabled"
          ><form v-if="!auth.pendingToken" @submit.prevent="onLoginSubmit">
            <label for="loginName">{{ t("login.loginName") }}</label
            ><ElInput
              id="loginName"
              v-model="login"
              size="large"
              autocomplete="username"
            />
            <label for="loginPass">{{ t("login.password") }}</label
            ><ElInput
              id="loginPass"
              v-model="password"
              size="large"
              type="password"
              show-password
              autocomplete="current-password"
            />
            <ElButton
              native-type="submit"
              type="primary"
              size="large"
              :loading="auth.loading"
              :disabled="auth.loading"
              >{{ t("login.next") }}</ElButton
            >
          </form>
          <form v-else @submit.prevent="onTotpSubmit">
            <p>{{ t("login.totpHint") }}</p>
            <label for="totpCode">{{ t("login.totpLabel") }}</label
            ><ElInput
              id="totpCode"
              ref="totpInput"
              v-model="code"
              size="large"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
            />
            <ElButton
              native-type="submit"
              type="primary"
              size="large"
              :disabled="auth.loading"
              :loading="auth.loading"
              >{{ t("login.totpSubmit") }}</ElButton
            ><ElButton @click="auth.backToLogin()">{{
              t("login.backToLogin")
            }}</ElButton>
          </form>
          <p role="alert">{{ auth.error }}</p></template
        >
      </section>
    </main>
  </div>
</template>
<style scoped>
.sso-button {
  display: block;
  text-align: center;
  padding: 14px;
  background: #365cf5;
  color: white;
  border-radius: 12px;
  margin: 18px 0;
}
.auth-page {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: #f5f7fc;
  color: #202b43;
}
.auth-story {
  padding: 10%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: linear-gradient(145deg, #172947, #233e76);
  color: white;
}
.auth-brand {
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.7px;
}
.auth-story h1 {
  font-size: clamp(36px, 4vw, 62px);
  line-height: 1.15;
  margin: 64px 0 24px;
  max-width: 550px;
}
.auth-story p {
  color: #bfcde5;
  line-height: 1.8;
  max-width: 400px;
}
.auth-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.auth-card {
  width: 100%;
  max-width: 420px;
}
.auth-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  gap: 16px;
}
.auth-heading h2 {
  font-size: 25px;
  font-weight: 700;
}
.auth-card .el-input {
  margin: 8px 0 22px;
}
.auth-card label {
  font-size: 13px;
  color: #52617a;
}
.auth-card .el-button {
  width: 100%;
  margin: 8px 0;
}
.auth-card p {
  font-size: 13px;
  line-height: 1.8;
  color: #63738b;
}
.auth-card [role="alert"] {
  color: #c33f49;
}
@media (max-width: 760px) {
  .sso-button {
    display: block;
    text-align: center;
    padding: 14px;
    background: #365cf5;
    color: white;
    border-radius: 12px;
    margin: 18px 0;
  }
  .auth-page {
    grid-template-columns: 1fr;
  }
  .auth-story {
    padding: 28px;
  }
  .auth-story h1 {
    font-size: 28px;
    margin: 24px 0 12px;
  }
  .auth-story p {
    display: none;
  }
  .auth-stage {
    padding: 30px 24px;
  }
}
</style>
