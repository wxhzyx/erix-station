<script setup lang="ts">
// 登录页：观感对齐旧 index.html renderLogin() 的 Bootstrap 登录卡（居中卡、品牌绿主按钮、
// 两步切换）。字段/按钮文案/错误展示位置保持逐字等价。
// issue #101 P1：用户可见文案走 i18n（login.*，zh-CN/en 逐字等价），卡片右上角挂语言切换菜单。
// 注意：错误提示 auth.error 来自 auth store（P2 归 errors.*），本阶段保持原样。
import { ref, nextTick, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore, afterLoginRoute } from '../stores/auth';
import LocaleSwitch from '../components/LocaleSwitch.vue';

const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const ssoEnabled = ref(false);
const passwordEnabled = ref(false);
const providerError = ref(false);
onMounted(async () => {
  try {
    const response = await fetch('/api/auth/providers');
    if (!response.ok) throw new Error('Login providers unavailable');
    const providers = await response.json();
    ssoEnabled.value = providers.sso === true;
    passwordEnabled.value = providers.password !== false;
  } catch { providerError.value = true; }
});

// 登录守卫携带的 redirect 回跳（如未登录访问 /session/<id> 深链）；仅允许站内路径。
function loginRedirect(): string {
  const r = route.query.redirect;
  return typeof r === 'string' && r.startsWith('/') ? r : afterLoginRoute(auth.user!);
}
const login = ref('');
const password = ref('');
const code = ref('');
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
  <div class="login-screen">
    <section class="login-story"><div class="rail-brand"><span class="brand-mark" aria-hidden="true">F<span>_</span></span><div><strong>FDE Station</strong><small>INTEVA · WORKSPACE</small></div></div><div><h1>{{ locale === 'en' ? 'From an idea' : '从一个想法' }}<br><span>{{ locale === 'en' ? 'to working software.' : '到真正的交付。' }}</span></h1><p>{{ locale === 'en' ? 'Your AI workspace for conversations, development and delivery.' : '把对话、开发与交付连接起来。属于你的 AI 工作空间，从这里开始。' }}</p></div><small>THINK / BUILD / DELIVER</small></section>
    <div class="login-card-wrap"><div class="login-card">
      <div class="p-4">
        <!-- 卡片头部：标题 + 语言切换（flex 头部，不遮挡表单） -->
        <div class="flex items-start justify-between gap-2 mb-3">
          <h2 class="text-xl font-medium">{{ t('login.title') }}</h2>
          <LocaleSwitch />
        </div>
        <p class="login-subtitle">{{ locale === 'en' ? 'Sign in with your organization account to continue.' : '使用企业账号登录，进入你的工作空间。' }}</p>

        <a v-if="ssoEnabled && (!passwordEnabled || !auth.pendingToken)" href="/api/auth/sso"
          class="block text-center w-full rounded-md bg-brand text-white py-2 mb-4">{{ t('login.sso') }}</a>
        <p v-if="route.query.sso_error" class="text-red-600 text-sm mb-3" role="alert">{{ t('login.ssoError') }}</p>
        <p v-if="providerError" class="text-red-600 text-sm mb-3" role="alert">{{ t('login.providerError') }}</p>

        <template v-if="passwordEnabled">
        <!-- 第一步：login + password -->
        <form v-if="!auth.pendingToken" @submit.prevent="onLoginSubmit">
          <label class="block text-xs text-black/50 mb-1" for="loginName">{{ t('login.loginName') }}</label>
          <input
            id="loginName" v-model="login" autocomplete="username"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <label class="block text-xs text-black/50 mb-1" for="loginPass">{{ t('login.password') }}</label>
          <input
            id="loginPass" v-model="password" type="password" autocomplete="current-password"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ t('login.next') }}</button>
        </form>

        <!-- 第二步：TOTP（pending_token 已换取） -->
        <form v-else @submit.prevent="onTotpSubmit">
          <p class="text-black/50 text-sm mb-3">{{ t('login.totpHint') }}</p>
          <label class="block text-xs text-black/50 mb-1" for="totpCode">{{ t('login.totpLabel') }}</label>
          <input
            id="totpCode" ref="totpInput" v-model="code"
            inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ t('login.totpSubmit') }}</button>
          <button
            type="button"
            class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5"
            @click="auth.backToLogin()"
          >{{ t('login.backToLogin') }}</button>
        </form>

        <p class="text-red-600 text-sm mt-3 mb-0" role="alert">{{ auth.error }}</p>
        </template>
      </div>
    </div>
    </div>
  </div>
</template>
