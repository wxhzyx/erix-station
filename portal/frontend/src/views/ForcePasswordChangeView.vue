<script setup lang="ts">
import { ElButton, ElInput } from "element-plus";
// #255 首登强制改密屏（受限会话的唯一出口，portal.md §2.11a / §2.6a）。
//
// 为什么它「关不掉」：本视图不是 modal（不套 ModalShell、没有关闭按钮、没有遮罩可点、Esc 无事可做），
// 而是 App.vue 里 `<router-view />` 的**替代分支**（第一道）+ router.ts 全局守卫的导航改写（第二道）。
// 受限态下工作台/会话视图/管理台整棵子树压根不挂载，顶栏 ☰ 导航与「管理台」链接不存在；
// 手改 URL、深链 #/session/<id>、前进/后退、登录后访问 /login 全部被改写到 /change-password。
// 唯一的离开方式是服务端把旗标清掉：提交成功后 store 会重新 `GET /api/me` 取真实旗标。
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { afterLoginRoute, useAuthStore } from "../stores/auth";
import { describeError, errorMeansRelogin } from "../lib/forcePasswordErrors";
import LocaleSwitch from "../components/LocaleSwitch.vue";

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const current = ref("");
const next = ref("");
const confirm = ref("");
// 本地预检文案（口令一致性只能在前端判：服务端只收 current/new，没有 confirm 字段，§2.6a）。
const localError = ref<string | null>(null);

const busy = computed(() => auth.loading);

// 失败态（前端 ②）：**码 → 可行动文案**的映射在 lib/forcePasswordErrors.ts（不在本视图里判码），
// 本视图只把它渲染成一行字符串。`describeError` 内部全部经 `toDisplayText` 退化 ⇒
// 模板里不可能出现 `[object Object]`（五种畸形形态的断言见 spec）。
const serverError = computed(() =>
  auth.changePasswordError ? describeError(auth.changePasswordError) : "",
);

async function onSubmit() {
  localError.value = null;
  if (!current.value || !next.value) {
    localError.value = t("forcePassword.incomplete");
    return;
  }
  if (next.value !== confirm.value) {
    localError.value = t("forcePassword.mismatch");
    return;
  }
  const released = await auth.changeOwnPassword({
    current_password: current.value,
    new_password: next.value,
    confirm_password: confirm.value,
  });
  // released=true 的唯一来源是改密后 `GET /api/me` 回答「不受限」⇒ 才允许进正常界面。
  // 会话保留（§2.6a：只吊销其它会话），所以回落地页而不是 /login。
  if (released && auth.user) {
    router.replace(afterLoginRoute(auth.user));
    return;
  }
  // 401 unauthorized（会话过期）⇒ **不要停在改密屏**：手里已经没会话了，重试一次也只是再撞 401。
  // ⚠ 与 401 invalid_credentials（旧口令打错，仍应留在屏上重输）的区分全在 code 上，
  // 判据在 lib/forcePasswordErrors.ts（§2.6a：两个 401 共用状态码）。
  const err = auth.changePasswordError;
  if (err && errorMeansRelogin(err)) {
    // 登录页顶部的 alert 要能解释「为什么人被送回来」——否则只剩一个空表单，像凭空掉线。
    const notice = t("forcePassword.errors.sessionExpiredNotice");
    auth.forgetExpiredSession();
    auth.error = notice;
    router.replace("/login");
  }
}

// 出口二：登出（§2.11a 放行清单里有 POST /api/auth/logout）——不想改密的人至少能换账号。
// 这是「离开会话」而不是「关掉界面」：换账号后若新会话仍受限，闸门照样落下。
async function onLogout() {
  await auth.logout();
  router.replace("/login");
}
</script>
<template>
  <div class="auth-page" data-test="force-password">
    <section class="auth-story">
      <div class="auth-brand">FDE / Station</div>
      <h1>{{ t("forcePassword.title") }}</h1>
      <p>{{ t("forcePassword.intro") }}</p>
    </section>
    <main class="auth-stage">
      <section class="auth-card">
        <div class="auth-heading">
          <h2>{{ t("forcePassword.title") }}</h2>
          <LocaleSwitch />
        </div>
        <p>{{ t("forcePassword.intro") }}</p>
        <form @submit.prevent="onSubmit">
          <label for="currentPassword">{{
            t("forcePassword.currentLabel")
          }}</label
          ><ElInput
            id="currentPassword"
            v-model="current"
            size="large"
            type="password"
            autocomplete="current-password"
            show-password
          />
          <label for="newPassword">{{
            t("forcePassword.newPasswordLabel")
          }}</label
          ><ElInput
            id="newPassword"
            v-model="next"
            size="large"
            type="password"
            autocomplete="new-password"
            show-password
          />
          <label for="confirmPassword">{{
            t("forcePassword.confirmPasswordLabel")
          }}</label
          ><ElInput
            id="confirmPassword"
            v-model="confirm"
            size="large"
            type="password"
            autocomplete="new-password"
            show-password
          />
          <ElButton
            type="primary"
            native-type="submit"
            size="large"
            :disabled="busy"
            :loading="busy"
            >{{
              busy ? t("forcePassword.submitting") : t("forcePassword.submit")
            }}</ElButton
          >
        </form>
        <p>{{ t("forcePassword.sessionHint") }}</p>
        <p v-if="localError" role="alert">{{ localError }}</p>
        <p
          v-else-if="serverError"
          role="alert"
          data-test="force-password-server-error"
        >
          {{ serverError }}
        </p>
        <ElButton :disabled="busy" @click="onLogout">{{
          t("forcePassword.logout")
        }}</ElButton>
      </section>
    </main>
  </div>
</template>
<style scoped>
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
