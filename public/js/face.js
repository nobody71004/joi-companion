/* ============================================================
   JoiFace — self-contained holographic companion face.
   Builds its own stage (canvas FX + SVG face), so any page just
   provides a sized container and calls:

     JoiFace.init('#holo-stage')
     JoiFace.setExpression('happy'|'sad'|'thoughtful'|'playful'|'focused'|'surprised'|'neutral')
     JoiFace.setTalking(true|false)     // lip-sync while she speaks
     JoiFace.speechImpulse(level)       // volume impulse
     JoiFace.setHue(deg)                // hologram color theme
     JoiFace.setListening(level)        // 0..1 mic activity

   Realistic portrait proportions (face in thirds, shorter neck),
   airbrush shading, soft-focus skin, strand-built hair, realistic
   irises and lips.
   ============================================================ */
(function (global) {
  'use strict';

  const FACE_SVG = `
<svg id="jf-svg" viewBox="0 40 400 440" xmlns="http://www.w3.org/2000/svg" aria-label="JOI hologram" role="img">
  <defs>
    <linearGradient id="jf-skin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe8d2"/>
      <stop offset="0.35" stop-color="#f6c9a6"/>
      <stop offset="0.7" stop-color="#eba97e"/>
      <stop offset="1" stop-color="#d98b5e"/>
    </linearGradient>
    <linearGradient id="jf-skinSheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.1"/>
    </linearGradient>
    <linearGradient id="jf-hairBack" x1="0.15" y1="0.1" x2="0.85" y2="1">
      <stop offset="0" stop-color="#9a6cf0"/>
      <stop offset="0.4" stop-color="#6a3cc4"/>
      <stop offset="0.75" stop-color="#45208f"/>
      <stop offset="1" stop-color="#2a135e"/>
    </linearGradient>
    <linearGradient id="jf-hairMid" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#b48af7"/>
      <stop offset="0.5" stop-color="#8a54d6"/>
      <stop offset="1" stop-color="#5a2ea0"/>
    </linearGradient>
    <linearGradient id="jf-hairFront" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#d9baff"/>
      <stop offset="0.5" stop-color="#a678e8"/>
      <stop offset="1" stop-color="#7a45c4"/>
    </linearGradient>
    <linearGradient id="jf-coat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a1f45"/>
      <stop offset="1" stop-color="#120c22"/>
    </linearGradient>
    <linearGradient id="jf-coatCollar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3a2b5e"/>
      <stop offset="0.5" stop-color="#4b3777"/>
      <stop offset="1" stop-color="#3a2b5e"/>
    </linearGradient>
    <linearGradient id="jf-lip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eda4ab"/>
      <stop offset="1" stop-color="#cf5d76"/>
    </linearGradient>
    <radialGradient id="jf-iris" cx="0.42" cy="0.4" r="0.75">
      <stop offset="0" stop-color="#f9dcab"/>
      <stop offset="0.55" stop-color="#bd7c3c"/>
      <stop offset="1" stop-color="#3d2413"/>
    </radialGradient>
    <radialGradient id="jf-blushG" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#f28a72" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#f28a72" stop-opacity="0"/>
    </radialGradient>
    <filter id="jf-blur2" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="jf-blur4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="jf-blur7" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="jf-blur12" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="jf-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.55"/></filter>
  </defs>

  <g id="jf-tilt">
    <g id="jf-head">

      <!-- ============ back hair (lower crown, softer top) ============ -->
      <g id="jf-hair-back">
        <ellipse cx="200" cy="212" rx="108" ry="124" fill="#6a3cc4" opacity="0.22" filter="url(#jf-blur12)"/>
        <path fill="url(#jf-hairBack)"
          d="M200 74 C124 78 90 138 98 228 C90 300 104 360 148 398 C128 366 118 326 124 274 C118 344 136 388 176 408 L224 408 C264 388 282 344 276 274 C282 326 272 366 252 398 C296 360 310 300 302 228 C310 138 276 78 200 74 Z"/>
        <path fill="url(#jf-hairMid)"
          d="M200 80 C146 84 112 130 120 212 C110 274 130 336 160 386 C140 344 132 296 140 244 C134 318 152 372 188 400 L212 400 C248 372 266 318 260 244 C268 296 260 344 240 386 C270 336 290 274 280 212 C288 130 254 84 200 80 Z"/>
        <path fill="url(#jf-hairMid)" opacity="0.85"
          d="M150 90 C124 124 110 176 112 244 C124 202 132 146 156 104 Z"/>
        <path fill="url(#jf-hairMid)" opacity="0.85"
          d="M250 90 C276 124 290 176 288 244 C276 202 268 146 244 104 Z"/>
        <path fill="url(#jf-hairBack)" opacity="0.9"
          d="M130 138 C110 172 104 224 112 282 C122 238 126 178 144 140 Z"/>
        <path fill="url(#jf-hairBack)" opacity="0.9"
          d="M270 138 C290 172 296 224 288 282 C278 238 274 178 256 140 Z"/>
        <path fill="#c46adf" opacity="0.6"
          d="M116 176 C100 212 98 260 108 312 C118 266 120 212 132 174 Z"/>
        <path fill="#c46adf" opacity="0.6"
          d="M284 176 C300 212 302 260 292 312 C282 266 280 212 268 174 Z"/>
        <path fill="#8a54d6" opacity="0.75"
          d="M138 112 C118 148 110 200 118 256 C128 212 132 156 152 114 Z"/>
        <path fill="#8a54d6" opacity="0.75"
          d="M262 112 C282 148 290 200 282 256 C272 212 268 156 248 114 Z"/>
        <path fill="#b48af7" opacity="0.7"
          d="M124 150 C106 186 102 240 112 296 C122 250 124 194 138 152 Z"/>
        <path fill="#b48af7" opacity="0.7"
          d="M276 150 C294 186 298 240 288 296 C278 250 276 194 262 152 Z"/>
        <path fill="#ffb8e6" opacity="0.5"
          d="M132 132 C114 168 110 216 120 268 C130 224 132 172 146 134 Z"/>
        <path fill="#ffb8e6" opacity="0.5"
          d="M268 132 C286 168 290 216 280 268 C270 224 268 172 254 134 Z"/>
        <path fill="none" stroke="#f2a7d4" stroke-width="2.2" stroke-opacity="0.5" stroke-linecap="round"
          d="M140 112 C120 152 112 208 118 266 M124 162 C110 200 108 248 118 298"/>
        <path fill="none" stroke="#f2a7d4" stroke-width="2.2" stroke-opacity="0.5" stroke-linecap="round"
          d="M260 112 C280 152 288 208 282 266 M276 162 C290 200 292 248 282 298"/>
        <path fill="none" stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.2" stroke-linecap="round"
          d="M156 96 C136 134 126 192 130 250 M244 96 C264 134 274 192 270 250"/>
      </g>

      <!-- ============ neck + coat (short neck) ============ -->
      <path id="jf-neck" fill="url(#jf-skin)" opacity="0.96"
        d="M186 300 L180 384 Q200 396 220 384 L214 300 Z"/>
      <rect x="178" y="312" width="7" height="66" rx="3" fill="#c07a4e" opacity="0.3" filter="url(#jf-blur4)"/>
      <rect x="215" y="312" width="7" height="66" rx="3" fill="#c07a4e" opacity="0.3" filter="url(#jf-blur4)"/>
      <ellipse cx="200" cy="312" rx="11" ry="6" fill="#c07a4e" opacity="0.24" filter="url(#jf-blur4)"/>
      <path fill="url(#jf-coat)"
        d="M56 480 C72 420 130 404 200 404 C270 404 328 420 344 480 Z"/>
      <path fill="url(#jf-coatCollar)" opacity="0.9"
        d="M172 406 Q200 424 228 406 L230 430 Q200 452 170 430 Z"/>
      <path fill="none" stroke="#ffd98a" stroke-width="1.4" stroke-opacity="0.3" stroke-linecap="round"
        d="M72 448 Q132 424 200 422 Q268 424 328 448"/>
      <path fill="none" stroke="#ffd98a" stroke-width="1.3" stroke-opacity="0.2" stroke-linecap="round"
        d="M164 450 Q200 462 236 450 M152 466 Q200 478 248 466"/>

      <!-- ============ face — airbrush shading (soft focus) ============ -->
      <g filter="url(#jf-soft)">
        <path id="jf-facebase" fill="url(#jf-skin)" opacity="0.97"
          d="M200 112 C228 112 252 128 262 158 C270 188 272 220 264 252 C256 282 246 292 226 298 C212 302 188 302 174 298 C154 292 144 282 136 252 C128 220 130 188 138 158 C148 128 172 112 200 112 Z"/>
        <path fill="url(#jf-skinSheen)" opacity="0.85"
          d="M200 112 C228 112 252 128 262 158 C270 188 272 220 264 252 C256 282 246 292 226 298 C212 302 188 302 174 298 C154 292 144 282 136 252 C128 220 130 188 138 158 C148 128 172 112 200 112 Z"/>
        <!-- hairline cast shadow + forehead -->
        <ellipse cx="200" cy="126" rx="58" ry="14" fill="#8f3fb8" opacity="0.12" filter="url(#jf-blur7)"/>
        <ellipse cx="200" cy="132" rx="26" ry="11" fill="#fff3e0" opacity="0.34" filter="url(#jf-blur7)"/>
        <ellipse cx="200" cy="150" rx="13" ry="7" fill="#f28a72" opacity="0.14" filter="url(#jf-blur7)"/>
        <ellipse cx="146" cy="146" rx="22" ry="14" fill="#7a3a9e" opacity="0.14" filter="url(#jf-blur7)"/>
        <ellipse cx="254" cy="146" rx="22" ry="14" fill="#7a3a9e" opacity="0.14" filter="url(#jf-blur7)"/>
        <ellipse cx="136" cy="166" rx="11" ry="22" fill="#c07a4e" opacity="0.3" filter="url(#jf-blur7)"/>
        <ellipse cx="264" cy="166" rx="11" ry="22" fill="#c07a4e" opacity="0.3" filter="url(#jf-blur7)"/>
        <!-- cheekbone structure -->
        <ellipse cx="177" cy="186" rx="12" ry="6" fill="#ffe9cf" opacity="0.5" filter="url(#jf-blur4)"/>
        <ellipse cx="223" cy="186" rx="12" ry="6" fill="#ffe9cf" opacity="0.5" filter="url(#jf-blur4)"/>
        <ellipse cx="164" cy="210" rx="13" ry="17" fill="#cf8456" opacity="0.3" filter="url(#jf-blur7)"/>
        <ellipse cx="236" cy="210" rx="13" ry="17" fill="#cf8456" opacity="0.3" filter="url(#jf-blur7)"/>
        <!-- jaw + chin -->
        <ellipse cx="149" cy="250" rx="11" ry="24" fill="#c07a4e" opacity="0.22" filter="url(#jf-blur7)"/>
        <ellipse cx="251" cy="250" rx="11" ry="24" fill="#c07a4e" opacity="0.22" filter="url(#jf-blur7)"/>
        <ellipse cx="200" cy="286" rx="14" ry="6" fill="#ffe9cf" opacity="0.4" filter="url(#jf-blur4)"/>
        <ellipse cx="200" cy="294" rx="16" ry="6" fill="#c07a4e" opacity="0.3" filter="url(#jf-blur4)"/>
        <!-- nose sculpting -->
        <rect x="183" y="180" width="7" height="50" rx="3.5" fill="#c07a4e" opacity="0.2" filter="url(#jf-blur4)"/>
        <rect x="210" y="180" width="7" height="50" rx="3.5" fill="#c07a4e" opacity="0.2" filter="url(#jf-blur4)"/>
        <ellipse cx="200" cy="208" rx="3.5" ry="16" fill="#ffe9cf" opacity="0.5" filter="url(#jf-blur2)"/>
        <ellipse cx="200" cy="240" rx="3.5" ry="2.6" fill="#ffffff" opacity="0.28" filter="url(#jf-blur2)"/>
        <ellipse cx="200" cy="245" rx="4.5" ry="2.6" fill="#c07a4e" opacity="0.35" filter="url(#jf-blur2)"/>
        <path fill="none" stroke="#d48a5e" stroke-width="1.8" stroke-opacity="0.4" stroke-linecap="round"
          d="M200 174 L200 236"/>
        <path fill="#a36840" opacity="0.75"
          d="M186 240 C 186 237 190 235 192 238 C 191 240 188 242 186 240 Z"/>
        <path fill="#a36840" opacity="0.75"
          d="M214 240 C 214 237 210 235 208 238 C 209 240 212 242 214 240 Z"/>
        <path fill="none" stroke="#cf8456" stroke-width="1.5" stroke-opacity="0.5" stroke-linecap="round"
          d="M200 262 L200 267"/>
        <path fill="none" stroke="#c07a4e" stroke-width="1.8" stroke-opacity="0.4" stroke-linecap="round"
          d="M170 268 q-3 -2 -5 1 M230 268 q3 -2 5 1"/>
      </g>

      <!-- ============ brows ============ -->
      <g id="jf-brow-l" class="jf-brow">
        <path fill="none" stroke="#6e3520" stroke-width="3.5" stroke-opacity="0.85" stroke-linecap="round" filter="url(#jf-blur2)"
          d="M155 174 Q168 166 184 172"/>
        <path fill="none" stroke="#5a2a18" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.9"
          d="M158 171 q4 -4 9 -5 M166 168 q6 -3 11 -2 M174 167 q7 -1 11 2 M182 169 q6 1 10 4"/>
      </g>
      <g id="jf-brow-r" class="jf-brow">
        <path fill="none" stroke="#6e3520" stroke-width="3.5" stroke-opacity="0.85" stroke-linecap="round" filter="url(#jf-blur2)"
          d="M216 172 Q232 166 245 174"/>
        <path fill="none" stroke="#5a2a18" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.9"
          d="M222 169 q6 -2 10 -4 M231 167 q6 -3 11 -2 M241 169 q5 1 9 4"/>
      </g>

      <!-- ============ eyes (crisp, realistic) ============ -->
      <g id="jf-eye-l" class="jf-eye">
        <ellipse cx="170" cy="182" rx="14" ry="7.5" fill="#cf8456" opacity="0.38" filter="url(#jf-blur4)"/>
        <path fill="none" stroke="#b5764c" stroke-width="1.6" stroke-opacity="0.5" stroke-linecap="round"
          d="M155 183 Q170 175 185 183"/>
        <path fill="#fbf2e3" d="M152 190 Q170 179 188 190 Q170 201 152 190 Z"/>
        <ellipse cx="156" cy="192" rx="3" ry="1.5" fill="#f4c9b8" opacity="0.7" filter="url(#jf-blur2)"/>
        <path fill="none" stroke="#000000" stroke-width="1.2" stroke-opacity="0.12" stroke-linecap="round"
          d="M154 189 Q170 181 186 189"/>
        <path fill="none" stroke="#241018" stroke-width="3.4" stroke-linecap="round" d="M150 188 Q170 175 190 188"/>
        <path fill="none" stroke="#241018" stroke-width="1.6" stroke-linecap="round" stroke-opacity="0.8"
          d="M188 185 q3 -3 5 -7 M183 182 q3 -4 5 -6 M178 180 q3 -3 6 -4"/>
        <path fill="none" stroke="#b5764c" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.5"
          d="M156 197 q4 3 8 3 M165 199 q5 1 8 0"/>
        <g id="jf-pupil-l" class="jf-pupil">
          <circle cx="170" cy="190" r="7.6" fill="url(#jf-iris)"/>
          <circle cx="170" cy="190" r="7.6" fill="none" stroke="#241408" stroke-width="1.2" stroke-opacity="0.8"/>
          <circle cx="170" cy="190" r="5.1" fill="none" stroke="#8a5a24" stroke-width="0.7" stroke-opacity="0.45"/>
          <circle cx="170" cy="190" r="3.2" fill="#1c0c04"/>
          <ellipse cx="173.6" cy="185.6" rx="2.5" ry="1.9" fill="#ffffff" opacity="0.95" transform="rotate(-18 173.6 185.6)"/>
          <circle cx="166.5" cy="195.5" r="1.05" fill="#ffffff" opacity="0.45"/>
        </g>
      </g>
      <g id="jf-eye-r" class="jf-eye">
        <ellipse cx="230" cy="182" rx="14" ry="7.5" fill="#cf8456" opacity="0.38" filter="url(#jf-blur4)"/>
        <path fill="none" stroke="#b5764c" stroke-width="1.6" stroke-opacity="0.5" stroke-linecap="round"
          d="M215 183 Q230 175 245 183"/>
        <path fill="#fbf2e3" d="M212 190 Q230 179 248 190 Q230 201 212 190 Z"/>
        <ellipse cx="244" cy="192" rx="3" ry="1.5" fill="#f4c9b8" opacity="0.7" filter="url(#jf-blur2)"/>
        <path fill="none" stroke="#000000" stroke-width="1.2" stroke-opacity="0.12" stroke-linecap="round"
          d="M214 189 Q230 181 246 189"/>
        <path fill="none" stroke="#241018" stroke-width="3.4" stroke-linecap="round" d="M210 188 Q230 175 250 188"/>
        <path fill="none" stroke="#241018" stroke-width="1.6" stroke-linecap="round" stroke-opacity="0.8"
          d="M212 180 q-3 -3 -6 -4 M217 182 q-3 -4 -5 -6 M222 185 q-3 -3 -5 -7"/>
        <path fill="none" stroke="#b5764c" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.5"
          d="M227 199 q-5 -1 -8 0 M235 197 q-4 -3 -8 -3"/>
        <g id="jf-pupil-r" class="jf-pupil">
          <circle cx="230" cy="190" r="7.6" fill="url(#jf-iris)"/>
          <circle cx="230" cy="190" r="7.6" fill="none" stroke="#241408" stroke-width="1.2" stroke-opacity="0.8"/>
          <circle cx="230" cy="190" r="5.1" fill="none" stroke="#8a5a24" stroke-width="0.7" stroke-opacity="0.45"/>
          <circle cx="230" cy="190" r="3.2" fill="#1c0c04"/>
          <ellipse cx="233.6" cy="185.6" rx="2.5" ry="1.9" fill="#ffffff" opacity="0.95" transform="rotate(-18 233.6 185.6)"/>
          <circle cx="226.5" cy="195.5" r="1.05" fill="#ffffff" opacity="0.45"/>
        </g>
      </g>

      <!-- ============ mouth (center y≈266) ============ -->
      <g id="jf-jaw">
        <g id="jf-mouth" class="jf-mouth">
          <path id="jf-mouth-inner" fill="#4a1420"/>
          <path id="jf-lip-upper" fill="url(#jf-lip)"/>
          <path id="jf-lip-lower" fill="url(#jf-lip)"/>
          <path fill="none" stroke="#9c4652" stroke-width="1.2" stroke-opacity="0.5" stroke-linecap="round"
            d="M176 263 Q186 257 200 261 Q214 257 224 263"/>
          <ellipse cx="200" cy="278" rx="10" ry="3" fill="#8a2f44" opacity="0.22" filter="url(#jf-blur2)"/>
          <ellipse cx="200" cy="274" rx="8" ry="2.3" fill="#ffffff" opacity="0.18" filter="url(#jf-blur2)"/>
        </g>
      </g>

      <!-- ============ blush ============ -->
      <ellipse id="jf-blush-l" cx="179" cy="232" rx="12" ry="6" fill="url(#jf-blushG)" filter="url(#jf-blur2)"/>
      <ellipse id="jf-blush-r" cx="221" cy="232" rx="12" ry="6" fill="url(#jf-blushG)" filter="url(#jf-blur2)"/>

      <!-- ============ front hair locks + bangs ============ -->
      <g id="jf-hair-front">
        <!-- side locks -->
        <path fill="url(#jf-hairFront)" opacity="0.95"
          d="M108 136 C94 174 98 226 118 282 C124 234 120 184 130 144 C124 172 120 206 126 244 C134 192 138 156 134 130 Z"/>
        <path fill="url(#jf-hairFront)" opacity="0.95"
          d="M292 136 C306 174 302 226 282 282 C276 234 280 184 270 144 C276 172 280 206 274 244 C266 192 262 156 266 130 Z"/>
        <path fill="#e98cbf" opacity="0.7"
          d="M120 164 C110 190 112 232 124 270 C130 230 128 192 134 164 Z"/>
        <path fill="#e98cbf" opacity="0.7"
          d="M280 164 C290 190 288 232 276 270 C270 230 272 192 266 164 Z"/>
        <!-- bangs sweeping the forehead -->
        <path fill="url(#jf-hairFront)" opacity="0.92"
          d="M132 118 C128 138 132 152 142 160 C136 138 142 128 150 116 Z"/>
        <path fill="url(#jf-hairFront)" opacity="0.92"
          d="M268 118 C272 138 268 152 258 160 C264 138 258 128 250 116 Z"/>
        <path fill="url(#jf-hairFront)" opacity="0.85"
          d="M160 112 C158 130 162 146 172 152 C166 132 170 124 176 112 Z"/>
        <path fill="url(#jf-hairFront)" opacity="0.85"
          d="M240 112 C242 130 238 146 228 152 C234 132 230 124 224 112 Z"/>
        <path fill="url(#jf-hairMid)" opacity="0.8"
          d="M188 110 C186 126 190 138 200 142 C194 124 198 116 204 110 Z"/>
        <path fill="url(#jf-hairMid)" opacity="0.8"
          d="M212 110 C214 126 210 138 200 142 C206 124 202 116 196 110 Z"/>
        <!-- crown shine -->
        <path fill="#f2a7d4" opacity="0.5"
          d="M170 88 C184 78 216 78 230 88 C210 82 190 82 170 88 Z"/>
        <path fill="none" stroke="#e98cbf" stroke-width="1.3" stroke-opacity="0.5" stroke-linecap="round"
          d="M126 172 q6 2 8 8 M122 200 q7 -1 9 6 M274 172 q-6 2 -8 8 M278 200 q-7 -1 -9 6"/>
      </g>

    </g>
  </g>
</svg>`;

  /* ---------- mouth shapes (cupid's bow, center y≈266) ---------- */
  const MOUTH = {
    closed: { inner: '',
      upper: 'M176 263 Q186 257 200 261 Q214 257 224 263',
      lower: 'M176 263 Q188 276 200 274 Q212 276 224 263' },
    smile: { inner: 'M178 261 Q200 252 222 261 Q200 274 178 261 Z',
      upper: 'M174 259 Q185 252 200 256 Q215 252 226 259',
      lower: 'M174 259 Q188 275 200 273 Q212 275 226 259' },
    frown: { inner: '',
      upper: 'M178 271 Q188 266 200 270 Q212 266 222 271',
      lower: 'M178 271 Q188 282 200 280 Q212 282 222 271' },
    pout: { inner: 'M187 264 Q200 259 213 264 Q200 273 187 264 Z',
      upper: 'M186 263 Q193 259 200 262 Q207 259 214 263',
      lower: 'M186 263 Q193 274 200 273 Q207 274 214 263' },
    smirk: { inner: 'M179 263 Q200 255 221 263 Q200 273 179 263 Z',
      upper: 'M176 262 Q187 255 202 259 Q213 259 223 261',
      lower: 'M176 262 Q187 275 202 273 Q213 273 223 262' },
    talk1: { inner: 'M179 264 Q200 258 221 264 Q200 276 179 264 Z',
      upper: 'M177 263 Q187 257 200 261 Q213 257 223 263',
      lower: 'M177 263 Q189 277 200 275 Q211 277 223 263' },
    talk2: { inner: 'M177 265 Q200 255 223 265 Q200 281 177 265 Z',
      upper: 'M175 264 Q186 255 200 260 Q214 255 225 264',
      lower: 'M175 264 Q188 280 200 278 Q212 280 225 264' },
    talk3: { inner: 'M175 267 Q200 252 225 267 Q200 288 175 267 Z',
      upper: 'M172 265 Q185 250 200 257 Q215 250 228 265',
      lower: 'M172 265 Q187 286 200 284 Q213 286 228 265' },
  };

  /* ---------- expressions ---------- */
  const EXPRESSIONS = {
    neutral:    { browL: { ty: 0, rot: 0 },  browR: { ty: 0, rot: 0 },  eye: { sy: 1,    ty: 0 }, mouth: 'closed', blush: 0.0, tilt: 0,    iris: 1 },
    happy:      { browL: { ty: -2, rot: 3 }, browR: { ty: -2, rot: -3 }, eye: { sy: 0.9,  ty: 0 }, mouth: 'smile',  blush: 0.5, tilt: 1.2,  iris: 1 },
    sad:        { browL: { ty: 1, rot: 5 },  browR: { ty: 1, rot: -5 },  eye: { sy: 0.82, ty: 3 }, mouth: 'frown',  blush: 0.0, tilt: -1.6, iris: 0.95 },
    thoughtful: { browL: { ty: -4, rot: -2 },browR: { ty: 1, rot: 2 },  eye: { sy: 0.9,  ty: 1 }, mouth: 'pout',   blush: 0.0, tilt: -2,   iris: 0.92 },
    playful:    { browL: { ty: -3, rot: 2 }, browR: { ty: 0, rot: -3 },  eye: { sy: 0.92, ty: 0 }, mouth: 'smirk',  blush: 0.4, tilt: 2.6,  iris: 1 },
    focused:    { browL: { ty: 0, rot: -1 }, browR: { ty: 0, rot: 1 },  eye: { sy: 0.78, ty: 1 }, mouth: 'closed', blush: 0.0, tilt: 0,    iris: 0.9 },
    surprised:  { browL: { ty: -3, rot: 0 }, browR: { ty: -3, rot: 0 }, eye: { sy: 1.15, ty: 0 }, mouth: 'pout',   blush: 0.0, tilt: 0,    iris: 0.85 },
  };

  const EXPRESSION_ORDER = ['neutral', 'happy', 'sad', 'thoughtful', 'playful', 'focused', 'surprised'];

  /* ---------- state ---------- */
  const state = {
    expr: 'neutral',
    talking: false,
    listening: 0,
    look: { x: 0, y: 0 },
    lastPointer: 0,
    gazeTarget: null,
    env: 0,
    talkBrow: 0,
    talkTimer: null,
    blinkTimer: null,
    els: null,
    canvas: null,
    ctx: null,
    particles: [],
    raf: 0,
  };

  /* ---------- build the stage ---------- */
  function init(containerSel, opts) {
    opts = opts || {};
    const container = typeof containerSel === 'string' ? document.querySelector(containerSel) : containerSel;
    if (!container) throw new Error('JoiFace: container not found: ' + containerSel);

    container.classList.add('jf-stage');
    container.innerHTML = `
      <canvas class="jf-fx"></canvas>
      <div class="jf-svg-wrap">${FACE_SVG}</div>
      <canvas class="jf-wave" aria-hidden="true"></canvas>
      <div class="jf-scanlines" aria-hidden="true"></div>
      <div class="jf-vignette" aria-hidden="true"></div>
      <div class="jf-watermark" aria-hidden="true">J O I</div>`;

    const canvas = container.querySelector('.jf-fx');
    const ctx = canvas.getContext('2d');
    const svg = container.querySelector('#jf-svg');
    const $ = (id) => svg.querySelector('#' + id);

    state.els = {
      container, canvas, ctx, svg,
      tilt: $('jf-tilt'), head: $('jf-head'),
      browL: $('jf-brow-l'), browR: $('jf-brow-r'),
      eyeL: $('jf-eye-l'), eyeR: $('jf-eye-r'),
      pupilL: $('jf-pupil-l'), pupilR: $('jf-pupil-r'),
      blushL: $('jf-blush-l'), blushR: $('jf-blush-r'),
      jaw: $('jf-jaw'),
      mouth: $('jf-mouth'),
      inner: $('jf-mouth-inner'), lipU: $('jf-lip-upper'), lipL: $('jf-lip-lower'),
    };
    state.canvas = canvas;
    state.ctx = ctx;

    state.els.wave = container.querySelector('.jf-wave');
    state.hue = 0;

    sizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(sizeCanvas).observe(container);
    }

    spawnParticles();
    applyExpression('neutral', true);

    // pointer look-at
    const svgWrap = container.querySelector('.jf-svg-wrap');
    window.addEventListener('pointermove', (e) => {
      const r = svgWrap.getBoundingClientRect();
      if (r.width === 0) return;
      const nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      const ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      state.look.x = Math.max(-1, Math.min(1, nx));
      state.look.y = Math.max(-1, Math.min(1, ny));
      state.lastPointer = performance.now();
      applyLook();
    }, { passive: true });

    scheduleBlink();
    state.raf = requestAnimationFrame(drawFx);
    if (opts.hue !== undefined) setHue(opts.hue);

    return api;
  }

  function sizeCanvas() {
    const c = state.els.container, canvas = state.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    state.dpr = dpr;
    const wv = state.els && state.els.wave;
    if (wv) {
      wv.width = Math.max(1, Math.round(w * 0.42 * dpr));
      wv.height = Math.max(1, Math.round(26 * dpr));
      wv.style.width = (w * 0.42) + 'px';
      wv.style.height = 26 + 'px';
    }
  }

  /* ---------- expressions ---------- */
  function applyExpression(name, instant) {
    const e = EXPRESSIONS[name] || EXPRESSIONS.neutral;
    state.expr = name;
    const { els } = state;
    const tr = instant ? '' : 'transform .5s cubic-bezier(.34,1.3,.5,1), opacity .5s ease';
    els.tilt.style.transition = tr;
    els.browL.style.transition = tr;
    els.browR.style.transition = tr;
    els.eyeL.style.transition = tr;
    els.eyeR.style.transition = tr;

    els.tilt.style.transform = `rotate(${e.tilt}deg)`;
    els.browL.style.transform = `translateY(${e.browL.ty}px) rotate(${e.browL.rot}deg)`;
    els.browR.style.transform = `translateY(${e.browR.ty}px) rotate(${e.browR.rot}deg)`;
    els.eyeL.style.transform = `translateY(${e.eye.ty}px) scaleY(${e.eye.sy})`;
    els.eyeR.style.transform = `translateY(${e.eye.ty}px) scaleY(${e.eye.sy})`;
    els.blushL.style.opacity = e.blush;
    els.blushR.style.opacity = e.blush;
    state.iris = e.iris || 1;
    if (!state.talking) setMouth(e.mouth);
    applyLook();
  }

  function applyLook() {
    const { els } = state;
    const tx = state.look.x * 2.2;
    const ty = state.look.y * 1.6;
    const ir = state.iris || 1;
    els.pupilL.style.transform = `translate(${tx}px, ${ty}px) scale(${ir})`;
    els.pupilR.style.transform = `translate(${tx}px, ${ty}px) scale(${ir})`;
  }

  /* ---------- mouth ---------- */
  function setMouth(name) {
    const m = MOUTH[name] || MOUTH.closed;
    const { els } = state;
    els.inner.setAttribute('d', m.inner);
    els.lipU.setAttribute('d', m.upper);
    els.lipL.setAttribute('d', m.lower);
  }

  function setTalking(on) {
    clearInterval(state.talkTimer);
    state.talking = !!on;
    state.els.svg.classList.toggle('jf-talking', on);
    if (on) {
      state.env = 0.9;
      state.talkBrow = 0;
      state.talkTimer = setInterval(tickTalk, 110);
      composeTalk(false);
    } else {
      state.env = 0;
      state.talkBrow = 0;
      applyExpression(state.expr); // restore expression pose, transitions and mouth
    }
  }

  /* Speech loop: an attack/decay envelope (fed by speechImpulse at word
     boundaries) drives the jaw, mouth, head-nod and brow together, so
     she looks like she is actually articulating. */
  function tickTalk() {
    state.env *= 0.78;
    if (state.env < 0.12) state.env = 0.12;
    state.talkBrow *= 0.8;
    if (Math.random() < 0.18) state.talkBrow = 1.4 + Math.random() * 1.4;
    composeTalk(false);
  }

  function composeTalk(reset) {
    const e = EXPRESSIONS[state.expr] || EXPRESSIONS.neutral;
    const { els } = state;
    if (reset) {
      setMouth(e.mouth);
    } else {
      const amp = Math.min(1, state.env);
      setMouth(amp > 0.62 ? 'talk3' : amp > 0.34 ? 'talk2' : 'talk1');
      els.jaw.style.transform = `translateY(${Math.max(0, amp - 0.2) * 3.5}px)`;
    }
    // head: expression tilt + speech nod
    els.tilt.style.transform = `rotate(${e.tilt}deg) translateY(${reset ? 0 : state.env * 1.6}px)`;
    // brows: expression + subtle emphasis
    const emph = reset ? 0 : state.talkBrow;
    els.browL.style.transform = `translateY(${e.browL.ty + emph}px) rotate(${e.browL.rot}deg)`;
    els.browR.style.transform = `translateY(${e.browR.ty - emph}px) rotate(${e.browR.rot}deg)`;
    // eyes: a touch narrower while articulating
    const esy = e.eye.sy * (reset ? 1 : 0.95);
    els.eyeL.style.transform = `translateY(${e.eye.ty}px) scaleY(${esy})`;
    els.eyeR.style.transform = `translateY(${e.eye.ty}px) scaleY(${esy})`;
  }

  function speechImpulse(level) {
    state.env = Math.max(state.env, level === undefined ? 1 : level);
  }

  function setListening(level) {
    state.listening = Math.max(0, Math.min(1, level || 0));
  }

  function setHue(deg) {
    state.hue = deg || 0;
    const wrap = state.els.container.querySelector('.jf-svg-wrap');
    if (wrap) wrap.style.filter = `hue-rotate(${deg}deg)`;
  }

  /* ---------- blink ---------- */
  function scheduleBlink() {
    clearTimeout(state.blinkTimer);
    state.blinkTimer = setTimeout(() => {
      const svg = state.els.svg;
      svg.classList.add('jf-blink');
      setTimeout(() => svg.classList.remove('jf-blink'), 240);
      scheduleBlink();
    }, 2200 + Math.random() * 3800);
  }

  /* ---------- canvas FX ---------- */
  function spawnParticles() {
    state.particles = [];
    for (let i = 0; i < 70; i++) {
      state.particles.push({
        x: Math.random(), y: Math.random(),
        r: 0.6 + Math.random() * 1.8,
        vy: 0.05 + Math.random() * 0.3,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.4 + Math.random() * 0.8,
        alpha: 0.08 + Math.random() * 0.3,
        pink: Math.random() < 0.75,
      });
    }
  }

  function drawFx(t) {
    const { canvas, ctx, els } = state;
    const dpr = state.dpr || 1;
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* idle gaze drift — she looks around when the cursor is away */
    if (t - state.lastPointer > 6000) {
      if (!state.gazeTarget || Math.random() < 0.004) {
        state.gazeTarget = { x: (Math.random() * 2 - 1) * 0.7, y: (Math.random() * 2 - 1) * 0.5 };
      }
      state.look.x += (state.gazeTarget.x - state.look.x) * 0.02;
      state.look.y += (state.gazeTarget.y - state.look.y) * 0.02;
      applyLook();
    }

    const speaking = state.talking || state.listening > 0.05;
    const cx = w / 2;
    const cy = h * 0.38;
    const rx = Math.min(w, h) * 0.33;
    const ry = rx * 1.16;
    const pulse = 1 + (speaking ? 0.016 : 0) + Math.sin(t / 900) * 0.006;

    /* emanator ring (soft pink-gold) */
    ctx.save();
    ctx.shadowColor = 'rgba(255, 150, 200, 0.5)';
    ctx.shadowBlur = 24 * dpr;
    ctx.strokeStyle = speaking ? 'rgba(255, 195, 220, 0.6)' : 'rgba(255, 185, 212, 0.42)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * pulse, ry * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 220, 240, 0.1)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 1.15 * pulse, ry * 1.15 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();

    /* rotating tick marks */
    ctx.save();
    ctx.translate(cx, cy);
    const rot = t / 4200;
    ctx.strokeStyle = 'rgba(255, 195, 220, 0.45)';
    ctx.lineWidth = 1.1 * dpr;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2 + rot;
      const r1 = rx * pulse * 0.985;
      const r2 = rx * pulse * 1.028;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1 * (ry / rx));
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2 * (ry / rx));
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();

    /* rising holo dust */
    for (const p of state.particles) {
      p.y -= p.vy * (1 / 60) * 2.2;
      p.sway += p.swaySpeed * (1 / 60) * 2.2;
      if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
      const px = (p.x + Math.sin(p.sway) * 0.015) * w;
      const py = p.y * h;
      const flicker = 0.6 + 0.4 * Math.sin(t / 300 + p.sway * 3);
      ctx.beginPath();
      ctx.arc(px, py, p.r * dpr, 0, Math.PI * 2);
      ctx.fillStyle = p.pink
        ? `rgba(255, 205, 225, ${p.alpha * flicker})`
        : `rgba(255, 240, 248, ${p.alpha * 0.7 * flicker})`;
      ctx.fill();
    }

    /* scanlines + drifting band */
    ctx.fillStyle = 'rgba(0,0,0,0.03)';
    for (let y = 0; y < h; y += 3 * dpr) ctx.fillRect(0, y, w, 1 * dpr);
    const bandY = ((t / 40) % (h + 220)) - 110;
    const grad = ctx.createLinearGradient(0, bandY - 60, 0, bandY + 60);
    grad.addColorStop(0, 'rgba(255,200,225,0)');
    grad.addColorStop(0.5, 'rgba(255,200,225,0.045)');
    grad.addColorStop(1, 'rgba(255,200,225,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, bandY - 60, w, 120);

    /* occasional holo glitch */
    if (Math.random() < 0.0014) {
      const gy = Math.random() * h;
      const gh = 20 * dpr + Math.random() * 40 * dpr;
      const slice = ctx.getImageData(0, gy, w, gh);
      ctx.putImageData(slice, (Math.random() - 0.5) * 40 * dpr, gy);
    }

    /* film grain */
    for (let i = 0; i < 130; i++) {
      const gx = Math.random() * w, gy = Math.random() * h;
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
      ctx.fillRect(gx, gy, 1 * dpr, 1 * dpr);
    }

    /* voice activity ring glow */
    if (state.listening > 0.02) {
      ctx.save();
      ctx.strokeStyle = `rgba(140,255,180,${0.25 + state.listening * 0.35})`;
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = 'rgba(140,255,180,0.5)';
      ctx.shadowBlur = 18 * dpr;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * (1.05 + state.listening * 0.08), ry * (1.05 + state.listening * 0.08), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawWave(t);

    state.raf = requestAnimationFrame(drawFx);
  }

  /* audio waveform under the portrait while speaking */
  function drawWave(t) {
    const wv = state.els.wave;
    if (!wv) return;
    const wctx = wv.getContext('2d');
    const ww = wv.width, wh = wv.height;
    const active = state.talking || state.listening > 0.05;
    wv.style.opacity = active ? 1 : 0;
    wctx.clearRect(0, 0, ww, wh);
    if (!active) return;
    const bars = 26;
    const bw = ww / bars;
    for (let i = 0; i < bars; i++) {
      const wave = 0.35 + 0.65 * Math.abs(Math.sin(t / 130 + i * 0.55));
      const amp = 0.3 + 0.7 * (state.env * 0.55 + 0.45) * Math.abs(Math.sin(t / 200 + i * 0.4));
      const bh = wh * (0.12 + wave * amp * 0.75);
      wctx.fillStyle = `rgba(255, 195, 222, ${0.3 + wave * 0.45})`;
      wctx.fillRect(i * bw + bw * 0.18, (wh - bh) / 2, bw * 0.6, bh);
    }
  }

  /* ---------- public API ---------- */
  const api = {
    init,
    setExpression: (n) => applyExpression(n),
    setTalking,
    speechImpulse,
    setListening,
    setHue,
    expressions: EXPRESSION_ORDER,
  };

  global.JoiFace = api;
})(window);
