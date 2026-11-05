# نصب سرور «نَفَس» روی سرور بیان‌نو (نسخه‌ی PHP)

این نسخه همان API نسخه‌ی Cloudflare است (همان مسیرها، قواعد و JSON) و با PHP 7.4 و MySQL روی همان nginx سرور بیان‌نو اجرا می‌شود. افزونه بدون تغییر کار می‌کند؛ فقط آدرس سرور `https://nafas.bayaneno.com` می‌شود.

## اصول (از قواعد سرور بیان‌نو)

- کاملاً جدا از بیان‌نو: پوشه‌ی جدا، دیتابیس و یوزر MySQL جدا، ساب‌دامنه‌ی جدا. هیچ فایلی از `domains/root/`، تننت‌ها یا CDN تغییر نمی‌کند.
- رمزها فقط در `server-php/.env` (بیرون از `public/` و بیرون از گیت، mode 600).
- قبل از هر تغییر در nginx بکاپ، و قبل از reload حتماً `nginx -t`.
- همه‌ی فایل‌ها با مالکیت `bayaneno`، نه root.

## مراحل

1. **DNS (ابرآروان):** رکورد `A` با نام `nafas` و مقدار `185.116.162.191`، با همان تنظیم پروکسی/SSL که بقیه‌ی ساب‌دامنه‌های bayaneno.com دارند.
2. **کد:** `git clone https://github.com/bayanenoGroup/team-break-extension.git /home/bayaneno/domains/nafas` با کاربر `bayaneno`.
3. **دیتابیس:** دیتابیس `bayaneno_nafas` (utf8mb4) و یوزر `bayaneno_nafas@localhost` با رمز تصادفی و دسترسی فقط روی همین دیتابیس. جدول‌ها را خود برنامه در اولین درخواست می‌سازد (InnoDB).
4. **`.env`:** از روی `server-php/.env.example`.
5. **nginx:** یک vhost از روی `server-php/nginx.example.conf`، با سوکت واقعی php74-fpm و همان روش SSL بقیه‌ی ساب‌دامنه‌ها.
6. **SSL:** گواهی برای `nafas.bayaneno.com`.
7. **تست:** `curl https://nafas.bayaneno.com/health` باید `{"ok":true,...}` بدهد، سپس `node server/test/api.smoke.mjs https://nafas.bayaneno.com` (۳۲ بررسی؛ چند کاربر و گروه آزمایشی در دیتابیس `bayaneno_nafas` می‌سازد که بی‌ضرر است).
8. **افزونه:** `DEFAULT_SERVER_URL` در `extension/config.js` = `https://nafas.bayaneno.com`.

## وضعیت نصب (۱۴ آبان ۱۴۰۵)

نصب شد و ۳۲ از ۳۲ تست API از بیرون پاس شد.

- کد: `/home/bayaneno/domains/nafas` (مالک bayaneno)
- vhost: `/etc/nginx/nafas.bayaneno.com.conf` (همان `server-php/nginx.example.conf`)، include از `/etc/nginx/nginx-includes.conf`؛ بکاپ: `nginx-includes.conf.bak-nafas-20261105-142750`
- PHP: pool `php74-1002` کاربر bayaneno
- SSL: گواهی پیش‌فرض سرور؛ کاربر گواهی ابرآروان را می‌بیند
- دیتابیس: `bayaneno_nafas` (InnoDB، utf8mb4)، یوزر `bayaneno_nafas@localhost` فقط روی همین دیتابیس
- پاسخ‌های API در ابرآروان کش نمی‌شوند (`x-cache: BYPASS`) و هدر Authorization رد می‌شود

## به‌روزرسانی

```bash
sudo -u bayaneno git -C /home/bayaneno/domains/nafas pull
```

PHP نیازی به ری‌استارت ندارد (مگر opcache با `validate_timestamps=0` تنظیم شده باشد؛ در آن صورت reload همان php-fpm).
