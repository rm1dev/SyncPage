/*!
 * SyncPage Jalali (Shamsi) date picker
 * Self-contained: no external dependency, no CDN.
 *
 * Usage:
 *   <input type="text" data-jalali-datepicker />
 * Value format written back to the input: YYYY/MM/DD (Jalali)
 */
(function () {
  'use strict';

  var MONTHS = [
    'فروردین',
    'اردیبهشت',
    'خرداد',
    'تیر',
    'مرداد',
    'شهریور',
    'مهر',
    'آبان',
    'آذر',
    'دی',
    'بهمن',
    'اسفند',
  ];
  // شنبه .. جمعه
  var WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

  function toEnglishDigits(value) {
    return String(value == null ? '' : value)
      .replace(/[۰-۹]/g, function (ch) {
        return String(ch.charCodeAt(0) - 1776);
      })
      .replace(/[٠-٩]/g, function (ch) {
        return String(ch.charCodeAt(0) - 1632);
      });
  }

  function pad2(n) {
    return String(n).length < 2 ? '0' + n : String(n);
  }

  function isLeapJalaliYear(jy) {
    // Matches jdate.js: (jy % 33 % 4 - 1) === floor(jy % 33 * 0.05)
    return ((jy % 33) % 4) - 1 === Math.floor((jy % 33) * 0.05);
  }

  function jalaliMonthLength(jy, jm) {
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    return isLeapJalaliYear(jy) ? 30 : 29;
  }

  /** jm is 1..12 */
  function jalaliToGregorian(jy, jm, jd) {
    var gy = jy <= 979 ? 621 : 1600;
    jy -= jy <= 979 ? 0 : 979;
    var days =
      365 * jy +
      Math.trunc(jy / 33) * 8 +
      Math.trunc(((jy % 33) + 3) / 4) +
      78 +
      jd +
      (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);

    gy += 400 * Math.trunc(days / 146097);
    days %= 146097;
    if (days > 36524) {
      gy += 100 * Math.trunc(--days / 36524);
      days %= 36524;
      if (days >= 365) days++;
    }
    gy += 4 * Math.trunc(days / 1461);
    days %= 1461;
    gy += Math.trunc((days - 1) / 365);
    if (days > 365) days = (days - 1) % 365;

    var gd = days + 1;
    var leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
    var lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var gm = 0;
    while (gm < 12 && gd > lengths[gm]) {
      gd -= lengths[gm];
      gm++;
    }
    return { year: gy, month: gm + 1, day: gd };
  }

  /** gm is 1..12 */
  function gregorianToJalali(gy, gm, gd) {
    var gDayMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = gy <= 1600 ? 0 : 979;
    gy -= gy <= 1600 ? 621 : 1600;
    var gy2 = gm > 2 ? gy + 1 : gy;
    var days =
      365 * gy +
      Math.trunc((gy2 + 3) / 4) -
      Math.trunc((gy2 + 99) / 100) +
      Math.trunc((gy2 + 399) / 400) -
      80 +
      gd +
      gDayMonth[gm - 1];

    jy += 33 * Math.trunc(days / 12053);
    days %= 12053;
    jy += 4 * Math.trunc(days / 1461);
    days %= 1461;
    jy += Math.trunc((days - 1) / 365);
    if (days > 365) days = (days - 1) % 365;

    var jm =
      days < 186
        ? 1 + Math.trunc(days / 31)
        : 7 + Math.trunc((days - 186) / 30);
    var jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
    return { year: jy, month: jm, day: jd };
  }

  function todayJalali() {
    var now = new Date();
    return gregorianToJalali(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate(),
    );
  }

  function formatJalali(parts) {
    return parts.year + '/' + pad2(parts.month) + '/' + pad2(parts.day);
  }

  /** Accepts Jalali "1403/01/01" (also with - or . separators, Persian digits). */
  function parseJalali(value) {
    var normalized = toEnglishDigits(value).trim();
    if (!normalized) return null;
    var match = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) return null;
    var year = parseInt(match[1], 10);
    var month = parseInt(match[2], 10);
    var day = parseInt(match[3], 10);
    if (!year || month < 1 || month > 12 || day < 1) return null;
    if (day > jalaliMonthLength(year, month)) return null;
    return { year: year, month: month, day: day };
  }

  /** Weekday index with Saturday = 0 (Jalali convention). */
  function jalaliWeekdayIndex(jy, jm, jd) {
    var g = jalaliToGregorian(jy, jm, jd);
    var date = new Date(g.year, g.month - 1, g.day);
    return (date.getDay() + 1) % 7;
  }

  var panel = null;
  var activeInput = null;
  var view = null;

  function buildPanel() {
    var el = document.createElement('div');
    el.className = 'jd-panel jd-hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'انتخاب تاریخ شمسی');
    // Prevent the input from losing focus before the click is handled.
    el.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    el.addEventListener('click', handlePanelClick);
    document.body.appendChild(el);
    return el;
  }

  function render() {
    if (!panel || !view) return;
    var jy = view.year;
    var jm = view.month;
    var selected = view.selected;
    var today = todayJalali();

    var parts = [];
    parts.push('<div class="jd-head">');
    if (view.mode === 'days') {
      parts.push(
        '<button type="button" class="jd-nav" data-jd-nav="prev-year" title="سال قبل">&#171;</button>',
        '<button type="button" class="jd-nav" data-jd-nav="prev-month" title="ماه قبل">&#8249;</button>',
        '<div class="jd-title">',
        '<button type="button" class="jd-title-btn" data-jd-mode="month">' +
          MONTHS[jm - 1] +
          '</button>',
        '<button type="button" class="jd-title-btn" data-jd-mode="year">' +
          jy +
          '</button>',
        '</div>',
        '<button type="button" class="jd-nav" data-jd-nav="next-month" title="ماه بعد">&#8250;</button>',
        '<button type="button" class="jd-nav" data-jd-nav="next-year" title="سال بعد">&#187;</button>',
      );
    } else if (view.mode === 'month') {
      parts.push(
        '<button type="button" class="jd-nav" data-jd-nav="prev-year" title="سال قبل">&#171;</button>',
        '<div class="jd-title"><span class="jd-title-btn">' +
          jy +
          '</span></div>',
        '<button type="button" class="jd-nav" data-jd-nav="next-year" title="سال بعد">&#187;</button>',
      );
    } else {
      parts.push(
        '<button type="button" class="jd-nav" data-jd-nav="prev-decade" title="دهه قبل">&#171;</button>',
        '<div class="jd-title"><span class="jd-title-btn">' +
          view.decadeStart +
          ' - ' +
          (view.decadeStart + 11) +
          '</span></div>',
        '<button type="button" class="jd-nav" data-jd-nav="next-decade" title="دهه بعد">&#187;</button>',
      );
    }
    parts.push('</div>');

    if (view.mode === 'days') {
      parts.push('<div class="jd-weekdays">');
      for (var w = 0; w < WEEKDAYS.length; w++) {
        parts.push('<span>' + WEEKDAYS[w] + '</span>');
      }
      parts.push('</div>');

      var firstWeekday = jalaliWeekdayIndex(jy, jm, 1);
      var monthLength = jalaliMonthLength(jy, jm);
      var prevMonth = jm === 1 ? 12 : jm - 1;
      var prevYear = jm === 1 ? jy - 1 : jy;
      var prevLength = jalaliMonthLength(prevYear, prevMonth);
      var nextMonth = jm === 12 ? 1 : jm + 1;
      var nextYear = jm === 12 ? jy + 1 : jy;

      parts.push('<div class="jd-grid">');
      for (var cell = 0; cell < 42; cell++) {
        var dayNumber;
        var cellYear = jy;
        var cellMonth = jm;
        var outside = false;

        if (cell < firstWeekday) {
          dayNumber = prevLength - (firstWeekday - cell) + 1;
          cellYear = prevYear;
          cellMonth = prevMonth;
          outside = true;
        } else if (cell >= firstWeekday + monthLength) {
          dayNumber = cell - (firstWeekday + monthLength) + 1;
          cellYear = nextYear;
          cellMonth = nextMonth;
          outside = true;
        } else {
          dayNumber = cell - firstWeekday + 1;
        }

        var classes = ['jd-cell'];
        if (outside) classes.push('jd-outside');
        if ((cell + 1) % 7 === 0 || (cell + 2) % 7 === 0)
          classes.push('jd-weekend');
        if (
          !outside &&
          today.year === cellYear &&
          today.month === cellMonth &&
          today.day === dayNumber
        ) {
          classes.push('jd-today');
        }
        if (
          selected &&
          selected.year === cellYear &&
          selected.month === cellMonth &&
          selected.day === dayNumber
        ) {
          classes.push('jd-selected');
        }

        parts.push(
          '<button type="button" class="' +
            classes.join(' ') +
            '" data-jd-day="' +
            dayNumber +
            '" data-jd-year="' +
            cellYear +
            '" data-jd-month="' +
            cellMonth +
            '">' +
            dayNumber +
            '</button>',
        );
      }
      parts.push('</div>');
      parts.push('<div class="jd-foot">');
      parts.push(
        '<button type="button" class="jd-foot-btn" data-jd-action="today">امروز</button>',
      );
      parts.push(
        '<button type="button" class="jd-foot-btn jd-clear" data-jd-action="clear">پاک کردن</button>',
      );
      parts.push('</div>');
    } else if (view.mode === 'month') {
      parts.push('<div class="jd-months">');
      for (var m = 1; m <= 12; m++) {
        var mClasses = ['jd-cell'];
        if (selected && selected.year === jy && selected.month === m) {
          mClasses.push('jd-selected');
        }
        parts.push(
          '<button type="button" class="' +
            mClasses.join(' ') +
            '" data-jd-month-pick="' +
            m +
            '">' +
            MONTHS[m - 1] +
            '</button>',
        );
      }
      parts.push('</div>');
    } else {
      parts.push('<div class="jd-years">');
      for (var y = view.decadeStart; y < view.decadeStart + 12; y++) {
        var yClasses = ['jd-cell'];
        if (selected && selected.year === y) yClasses.push('jd-selected');
        parts.push(
          '<button type="button" class="' +
            yClasses.join(' ') +
            '" data-jd-year-pick="' +
            y +
            '">' +
            y +
            '</button>',
        );
      }
      parts.push('</div>');
    }

    panel.innerHTML = parts.join('');
  }

  function positionPanel() {
    if (!panel || !activeInput) return;
    var rect = activeInput.getBoundingClientRect();
    var panelWidth = panel.offsetWidth || 280;
    var panelHeight = panel.offsetHeight || 320;

    var left = rect.left;
    if (left + panelWidth > window.innerWidth - 8) {
      left = window.innerWidth - panelWidth - 8;
    }
    if (left < 8) left = 8;

    var top = rect.bottom + 6;
    if (top + panelHeight > window.innerHeight - 8) {
      var above = rect.top - panelHeight - 6;
      top =
        above >= 8 ? above : Math.max(8, window.innerHeight - panelHeight - 8);
    }

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function openFor(input) {
    if (!panel) panel = buildPanel();

    // Re-opening the same already-open field should keep the current view state.
    if (
      activeInput === input &&
      panel &&
      !panel.classList.contains('jd-hidden')
    ) {
      positionPanel();
      return;
    }

    activeInput = input;

    var parsed = parseJalali(input.value);
    var base = parsed || todayJalali();
    var today = todayJalali();
    view = {
      mode: 'days',
      year: base.year,
      month: base.month,
      selected: parsed,
      decadeStart:
        (parsed ? parsed.year : today.year) -
        ((parsed ? parsed.year : today.year) % 12),
    };

    panel.classList.remove('jd-hidden');
    render();
    positionPanel();
  }

  function close() {
    if (panel) panel.classList.add('jd-hidden');
    activeInput = null;
    view = null;
  }

  function commit(parts) {
    if (!activeInput) return;
    activeInput.value = formatJalali(parts);
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  }

  function handlePanelClick(event) {
    var target = event.target;
    if (!target || target.nodeType !== 1) return;

    var nav = target.getAttribute('data-jd-nav');
    if (nav) {
      if (nav === 'prev-year') view.year -= 1;
      if (nav === 'next-year') view.year += 1;
      if (nav === 'prev-month') {
        view.month -= 1;
        if (view.month < 1) {
          view.month = 12;
          view.year -= 1;
        }
      }
      if (nav === 'next-month') {
        view.month += 1;
        if (view.month > 12) {
          view.month = 1;
          view.year += 1;
        }
      }
      if (nav === 'prev-decade') view.decadeStart -= 12;
      if (nav === 'next-decade') view.decadeStart += 12;
      render();
      positionPanel();
      return;
    }

    var mode = target.getAttribute('data-jd-mode');
    if (mode) {
      view.mode = mode === 'month' ? 'month' : 'year';
      if (view.mode === 'year') {
        view.decadeStart = view.year - (view.year % 12);
      }
      render();
      positionPanel();
      return;
    }

    var monthPick = target.getAttribute('data-jd-month-pick');
    if (monthPick) {
      view.month = parseInt(monthPick, 10);
      view.mode = 'days';
      render();
      positionPanel();
      return;
    }

    var yearPick = target.getAttribute('data-jd-year-pick');
    if (yearPick) {
      view.year = parseInt(yearPick, 10);
      view.mode = 'month';
      render();
      positionPanel();
      return;
    }

    var dayPick = target.getAttribute('data-jd-day');
    if (dayPick) {
      commit({
        year: parseInt(target.getAttribute('data-jd-year'), 10),
        month: parseInt(target.getAttribute('data-jd-month'), 10),
        day: parseInt(dayPick, 10),
      });
      return;
    }

    var action = target.getAttribute('data-jd-action');
    if (action === 'today') {
      commit(todayJalali());
    } else if (action === 'clear') {
      if (activeInput) {
        activeInput.value = '';
        activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
    }
  }

  function attach(input) {
    if (!input || input.__jdBound) return;
    input.__jdBound = true;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('inputmode', 'numeric');
    if (!input.getAttribute('placeholder')) {
      input.setAttribute('placeholder', '1403/01/01');
    }
    input.addEventListener('focus', function () {
      openFor(input);
    });
    input.addEventListener('click', function () {
      openFor(input);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close();
    });
    // Keep the field Jalali-only: convert Latin/Persian digits as the user types.
    input.addEventListener('blur', function () {
      var parsed = parseJalali(input.value);
      if (parsed) input.value = formatJalali(parsed);
    });
  }

  function attachAll(root) {
    var scope = root || document;
    var inputs = scope.querySelectorAll('input[data-jalali-datepicker]');
    for (var i = 0; i < inputs.length; i++) attach(inputs[i]);
  }

  document.addEventListener('mousedown', function (event) {
    if (!panel || panel.classList.contains('jd-hidden')) return;
    if (panel.contains(event.target)) return;
    if (activeInput && activeInput === event.target) return;
    close();
  });

  window.addEventListener('resize', function () {
    if (panel && !panel.classList.contains('jd-hidden')) positionPanel();
  });
  window.addEventListener(
    'scroll',
    function () {
      if (panel && !panel.classList.contains('jd-hidden')) positionPanel();
    },
    true,
  );

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });

  function boot() {
    attachAll(document);
    if (typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node && node.nodeType === 1) {
              if (
                node.matches &&
                node.matches('input[data-jalali-datepicker]')
              ) {
                attach(node);
              }
              attachAll(node);
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SyncPageJalaliDatepicker = {
    attach: attach,
    attachAll: attachAll,
    open: openFor,
    close: close,
    parse: parseJalali,
    format: formatJalali,
    today: todayJalali,
    gregorianToJalali: gregorianToJalali,
    jalaliToGregorian: jalaliToGregorian,
  };
})();
