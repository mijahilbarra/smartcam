<script setup>
</script>

<template>
  <div class="min-h-screen bg-slate-900 text-slate-100 font-sans flex flex-col items-center">
    <div class="w-full max-w-7xl px-3 sm:px-6 py-4 sm:py-6 flex flex-col gap-5">
      <!-- Header slot -->
      <slot name="header" />

      <!-- Tabs navigation slot -->
      <slot name="navigation" />

      <!-- Main body content slot -->
      <main class="w-full flex flex-col gap-6">
        <slot />
      </main>
    </div>

    <!-- Modals slot -->
    <slot name="modals" />
  </div>
</template>
