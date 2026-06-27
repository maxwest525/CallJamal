const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // Set demo user & mode
  await page.evaluate(() => {
    localStorage.setItem('cj_current_user', JSON.stringify({ id: 'demo-1', name: 'Chris B', email: 'chris@noahconnect.com' }));
    localStorage.setItem('cj_demo_mode', 'true');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Enable demo toggle
  const demoToggle = page.locator('#demoToggle');
  if (await demoToggle.count() > 0) {
    const isChecked = await demoToggle.isChecked();
    if (!isChecked) {
      await demoToggle.check({ force: true });
      await page.waitForTimeout(300);
    }
  }

  const views = ['team', 'messages', 'conversations', 'gmail', 'slack', 'rcai'];

  for (const view of views) {
    await page.evaluate((v) => {
      const btn = document.querySelector(`[data-view="${v}"]`);
      if (btn) btn.click();
    }, view);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `/tmp/claude-0/-home-user-CallJamal/366d393a-eb0e-5292-b62a-24286477c7ad/scratchpad/redesign-${view}.png` });
    console.log(`Captured: ${view}`);
  }

  await browser.close();
  console.log('Done!');
})();
