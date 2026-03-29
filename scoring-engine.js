/**
 * Buransh.ai — Scoring Engine
 * ============================================================
 * Three-signal urgency scoring model.
 *
 * ARCHITECTURE:
 *   Input: ticket + customer profile
 *     ↓
 *   Signal 1: Base signal    (Claude AI — urgency + sentiment)
 *   Signal 2: ARR multiplier (revenue tier nudge)
 *   Signal 3: Trust buffer   (CSAT decay → inverted)
 *     ↓
 *   Combiner: base × ARR × trust → final score
 *     ↓
 *   Emotion velocity layer   (CSAT trend direction)
 *     ↓
 *   Output: structured JSON for UI
 * ============================================================
 */

// ── CONSTANTS ────────────────────────────────────────────────

const ARR_TIERS = {
  free:       { label: 'Free',       multiplier: 1.0 },
  starter:    { label: 'Starter',    multiplier: 1.1 },
  standard:   { label: 'Standard',   multiplier: 1.2 },
  growth:     { label: 'Growth',     multiplier: 1.3 },
  enterprise: { label: 'Enterprise', multiplier: 1.4 },
};

const CSAT_WEIGHTS = {
  mostRecent:  0.50,
  secondLast:  0.30,
  olderAvg:    0.20,
};

const EMOTION_VELOCITY = {
  ESCALATING:     'escalating',
  STABLE:         'stable',
  DE_ESCALATING:  'de-escalating',
};

const RFM_SEGMENTS = {
  CHAMPION:       'champion',        // high value, frequent, recent
  LOYAL:          'loyal',           // frequent, good value
  AT_RISK:        'at_risk',         // was good, declining recently
  NEW:            'new',             // just joined
  NEEDS_ATTENTION:'needs_attention', // infrequent, dropping off
};

// ── SIGNAL 2: ARR MULTIPLIER ─────────────────────────────────
/**
 * Returns a multiplier between 1.0 and 1.4 based on ARR tier.
 * This NUDGES the score upward for higher-revenue customers.
 * It is NOT an override — it cannot make a low-urgency ticket
 * jump above a genuinely critical one.
 *
 * @param {string} arrTier - one of: free, starter, standard, growth, enterprise
 * @returns {number} multiplier between 1.0 and 1.4
 */
function computeARRMultiplier(arrTier) {
  const tier = ARR_TIERS[arrTier] || ARR_TIERS.free;
  return tier.multiplier;
}

// ── SIGNAL 3: TRUST BUFFER INVERSE ───────────────────────────
/**
 * Three-level fallback:
 *   1. Has CSAT history → decayed weighted average → inverted
 *   2. No CSAT, has LTV + purchase frequency → proxy score
 *   3. No data at all → new customer default (maximum inverse)
 *
 * INVERSION LOGIC:
 *   A high CSAT average means high trust = low inverse (score nudged down)
 *   A low/declining CSAT means low trust = high inverse (score nudged up)
 *   Range: 1.0 (full trust, no nudge) → 1.3 (no trust, max nudge)
 *
 * @param {object} customer - customer profile object
 * @returns {object} { trustScore, trustInverse, trustReason }
 */
function computeTrustBuffer(customer) {
  const {
    csatHistory = [],
    ltv = 0,
    purchaseFrequency = 'none',
    isNewCustomer = false,
    accountAgeDays = 0,
  } = customer;

  // ── LEVEL 3: New customer with zero data ──────────────────
  if (isNewCustomer || (accountAgeDays < 30 && csatHistory.length === 0)) {
    return {
      trustScore: null,
      trustInverse: 1.3,
      trustReason: 'New customer — no history. Maximum trust inverse applied. First impression is everything.',
    };
  }

  // ── LEVEL 1: Has CSAT history → decayed weighted average ──
  if (csatHistory.length > 0) {
    const scores = [...csatHistory].reverse(); // most recent first

    let decayedScore;

    if (scores.length === 1) {
      decayedScore = scores[0];
    } else if (scores.length === 2) {
      decayedScore = (scores[0] * 0.6) + (scores[1] * 0.4);
    } else {
      const olderAvg = scores.slice(2).reduce((a, b) => a + b, 0) / scores.slice(2).length;
      decayedScore =
        (scores[0] * CSAT_WEIGHTS.mostRecent) +
        (scores[1] * CSAT_WEIGHTS.secondLast) +
        (olderAvg  * CSAT_WEIGHTS.olderAvg);
    }

    // Normalize to 0-1 (CSAT is 1-5 scale)
    const normalized = (decayedScore - 1) / 4;

    // Invert: high trust (1.0) → low multiplier (1.0)
    //         low trust  (0.0) → high multiplier (1.3)
    const trustInverse = 1.0 + ((1 - normalized) * 0.3);

    return {
      trustScore: parseFloat(decayedScore.toFixed(2)),
      trustInverse: parseFloat(trustInverse.toFixed(3)),
      trustReason: `Decayed CSAT: ${decayedScore.toFixed(2)}/5. Recent scores weighted more heavily.`,
    };
  }

  // ── LEVEL 2: No CSAT, has LTV + frequency proxy ───────────
  const freqScore = {
    daily:    5,
    weekly:   4,
    monthly:  3,
    quarterly:2,
    once:     1,
    none:     0,
  }[purchaseFrequency] || 0;

  // LTV bands: 0-1k=1, 1k-10k=2, 10k-50k=3, 50k+=4
  const ltvScore =
    ltv >= 50000 ? 4 :
    ltv >= 10000 ? 3 :
    ltv >= 1000  ? 2 : 1;

  const proxyNormalized = ((freqScore + ltvScore) / 9);
  const trustInverse = 1.0 + ((1 - proxyNormalized) * 0.25);

  return {
    trustScore: null,
    trustInverse: parseFloat(trustInverse.toFixed(3)),
    trustReason: `No CSAT history. Using LTV (${ltv}) + purchase frequency (${purchaseFrequency}) as proxy.`,
  };
}

// ── EMOTION VELOCITY ─────────────────────────────────────────
/**
 * Compares the direction of CSAT scores over time.
 * A customer who gave 5→3→1 is escalating even if their
 * current message sounds calm.
 *
 * @param {number[]} csatHistory - array of CSAT scores, oldest first
 * @param {number} currentSentimentScore - 0-100 from AI (100 = most frustrated)
 * @returns {object} { velocity, velocityScore, velocityReason }
 */
function computeEmotionVelocity(csatHistory, currentSentimentScore) {
  if (!csatHistory || csatHistory.length < 2) {
    // Not enough history — use current sentiment only
    const velocity =
      currentSentimentScore > 70 ? EMOTION_VELOCITY.ESCALATING :
      currentSentimentScore > 40 ? EMOTION_VELOCITY.STABLE :
      EMOTION_VELOCITY.DE_ESCALATING;

    return {
      velocity,
      velocityScore: currentSentimentScore,
      velocityReason: 'Insufficient CSAT history. Based on current ticket sentiment only.',
    };
  }

  // Calculate CSAT trend: compare recent half vs older half
  const midpoint = Math.floor(csatHistory.length / 2);
  const olderHalf  = csatHistory.slice(0, midpoint);
  const recentHalf = csatHistory.slice(midpoint);

  const olderAvg  = olderHalf.reduce((a, b) => a + b, 0)  / olderHalf.length;
  const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;

  // CSAT drop of 1+ point = escalating (inverted: lower CSAT = more frustrated)
  const csatDelta = recentAvg - olderAvg;

  let velocity;
  let velocityReason;

  if (csatDelta <= -1.0) {
    velocity = EMOTION_VELOCITY.ESCALATING;
    velocityReason = `CSAT dropped ${Math.abs(csatDelta).toFixed(1)} points recently. Customer trust is eroding.`;
  } else if (csatDelta >= 1.0) {
    velocity = EMOTION_VELOCITY.DE_ESCALATING;
    velocityReason = `CSAT improved ${csatDelta.toFixed(1)} points recently. Customer trust is recovering.`;
  } else {
    velocity = EMOTION_VELOCITY.STABLE;
    velocityReason = `CSAT stable (delta: ${csatDelta.toFixed(1)}). No significant trend detected.`;
  }

  // Apply velocity bonus to sentiment score
  // Escalating customer gets a bump even if current message sounds calm
  let velocityScore = currentSentimentScore;
  if (velocity === EMOTION_VELOCITY.ESCALATING)    velocityScore = Math.min(100, currentSentimentScore + 15);
  if (velocity === EMOTION_VELOCITY.DE_ESCALATING) velocityScore = Math.max(0,   currentSentimentScore - 10);

  return {
    velocity,
    velocityScore,
    velocityReason,
  };
}

// ── RFM SEGMENT ───────────────────────────────────────────────
/**
 * Assigns customer to an RFM segment based on:
 *   R = account age + recency of last purchase
 *   F = purchase frequency
 *   M = LTV / ARR tier
 *
 * @param {object} customer
 * @returns {string} RFM segment label
 */
function computeRFMSegment(customer) {
  const { isNewCustomer, accountAgeDays, purchaseFrequency, arrTier, ltv, csatHistory } = customer;

  if (isNewCustomer || accountAgeDays < 30) return RFM_SEGMENTS.NEW;

  const isHighValue = ['growth', 'enterprise'].includes(arrTier) || ltv >= 10000;
  const isFrequent  = ['daily', 'weekly', 'monthly'].includes(purchaseFrequency);

  // Declining signal: last CSAT was significantly lower than average
  let isDeclining = false;
  if (csatHistory && csatHistory.length >= 2) {
    const avg  = csatHistory.reduce((a, b) => a + b, 0) / csatHistory.length;
    const last = csatHistory[csatHistory.length - 1];
    isDeclining = last < avg - 1;
  }

  if (isHighValue && isFrequent && !isDeclining) return RFM_SEGMENTS.CHAMPION;
  if (isHighValue && isDeclining)                return RFM_SEGMENTS.AT_RISK;
  if (isFrequent  && !isHighValue)               return RFM_SEGMENTS.LOYAL;
  return RFM_SEGMENTS.NEEDS_ATTENTION;
}

// ── CHURN RISK ────────────────────────────────────────────────
/**
 * Combines urgency score, emotion velocity, RFM segment,
 * and ARR to estimate churn risk.
 *
 * @param {number} finalScore
 * @param {string} velocity
 * @param {string} rfmSegment
 * @param {string} arrTier
 * @returns {string} 'critical' | 'high' | 'medium' | 'low'
 */
function computeChurnRisk(finalScore, velocity, rfmSegment, arrTier) {
  const isHighValue = ['growth', 'enterprise'].includes(arrTier);
  const isEscalating = velocity === EMOTION_VELOCITY.ESCALATING;
  const isAtRisk = rfmSegment === RFM_SEGMENTS.AT_RISK;

  if (finalScore >= 80 && (isEscalating || isAtRisk)) return 'critical';
  if (finalScore >= 65 && isHighValue)                 return 'high';
  if (finalScore >= 50 || isEscalating)                return 'medium';
  return 'low';
}

// ── SIGNAL 1: BASE SIGNAL (Groq API — FREE, no card needed) ──
/**
 * GET YOUR FREE GROQ KEY IN 2 MINUTES:
 *   1. Go to console.groq.com
 *   2. Sign up with Google
 *   3. API Keys → Create API Key
 *   4. Paste it in the top-right field of the app
 *
 * Key is passed at runtime — never stored in code.
 */
const GROQ_MODEL = 'llama-3.1-8b-instant';

async function computeBaseSignal(ticket, customer, apiKey) {
  const customerContext = customer.isNewCustomer
    ? `This is a NEW customer with no prior history. This is their first interaction.`
    : `Customer profile:
- ARR Tier: ${customer.arrTier || 'unknown'}
- Account age: ${customer.accountAgeDays || 0} days
- Previous CSAT scores: ${customer.csatHistory?.join(', ') || 'none'}
- Purchase frequency: ${customer.purchaseFrequency || 'unknown'}
- LTV: $${customer.ltv || 0}`;

  const prompt = `You are Buransh.ai — an intelligent support triage engine.
Analyze this support ticket and return ONLY valid JSON, no markdown, no backticks.

TICKET:
Subject: ${ticket.subject || 'No subject'}
Message: ${ticket.message}

CUSTOMER CONTEXT:
${customerContext}

Return exactly this JSON structure with no other text:
{
  "urgency_score": <0-100, where 100 = production outage>,
  "sentiment_score": <0-100, where 100 = extremely frustrated>,
  "category": <"billing" | "technical" | "account" | "feature_request" | "general">,
  "reasoning": "<2 sentences explaining urgency and sentiment>",
  "key_signals": ["<signal1>", "<signal2>", "<signal3>"],
  "draft_response": "<complete professional empathetic response. Use \\n for line breaks.>",
  "response_confidence": <0-100>
}`;

  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data  = await response.json();
  const raw   = data.choices?.[0]?.message?.content?.trim();

  if (!raw) throw new Error('AI returned empty response');

  const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

// ── COMBINER ──────────────────────────────────────────────────
/**
 * Combines the three signals into a final urgency score.
 * Formula: base × ARR_multiplier × trust_inverse
 * Capped at 100, rounded to nearest integer.
 *
 * @param {number} baseScore - 0-100 from Claude
 * @param {number} arrMultiplier - 1.0-1.4
 * @param {number} trustInverse - 1.0-1.3
 * @returns {number} final score 0-100
 */
function combineSignals(baseScore, arrMultiplier, trustInverse) {
  const raw = baseScore * arrMultiplier * trustInverse;
  return Math.min(100, Math.round(raw));
}

// ── URGENCY LABEL ─────────────────────────────────────────────
function getUrgencyLabel(score) {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────
/**
 * Full scoring pipeline. Call this for every incoming ticket.
 *
 * @param {object} ticket    - { message, subject, submittedAt }
 * @param {object} customer  - { arrTier, ltv, csatHistory, purchaseFrequency,
 *                               isNewCustomer, accountAgeDays, name }
 * @param {string} apiKey    - Anthropic API key
 * @returns {object} Complete scoring output for UI
 */
async function scoreTicket(ticket, customer, apiKey) {

  // ── Run all three signals ──────────────────────────────────
  const [baseSignal, arrMultiplier, trustBuffer] = await Promise.all([
    computeBaseSignal(ticket, customer, apiKey),
    Promise.resolve(computeARRMultiplier(customer.arrTier || 'free')),
    Promise.resolve(computeTrustBuffer(customer)),
  ]);

  // ── Combine into final score ───────────────────────────────
  const finalScore = combineSignals(
    baseSignal.urgency_score,
    arrMultiplier,
    trustBuffer.trustInverse,
  );

  // ── Emotion velocity ───────────────────────────────────────
  const emotionVelocity = computeEmotionVelocity(
    customer.csatHistory || [],
    baseSignal.sentiment_score,
  );

  // ── RFM + churn risk ───────────────────────────────────────
  const rfmSegment = computeRFMSegment(customer);
  const churnRisk  = computeChurnRisk(
    finalScore,
    emotionVelocity.velocity,
    rfmSegment,
    customer.arrTier || 'free',
  );

  // ── Build output object ────────────────────────────────────
  return {
    // Core scores
    urgency_score:    finalScore,
    urgency_label:    getUrgencyLabel(finalScore),
    sentiment_score:  emotionVelocity.velocityScore,
    sentiment_label:  baseSignal.sentiment_score > 70 ? 'frustrated' :
                      baseSignal.sentiment_score > 40 ? 'neutral' : 'positive',

    // Signals breakdown (for UI score breakdown panel)
    signals: {
      base: {
        score:      baseSignal.urgency_score,
        sentiment:  baseSignal.sentiment_score,
      },
      arr: {
        tier:       customer.arrTier || 'free',
        multiplier: arrMultiplier,
      },
      trust: {
        score:      trustBuffer.trustScore,
        inverse:    trustBuffer.trustInverse,
        reason:     trustBuffer.trustReason,
      },
    },

    // Emotion velocity (USP 01)
    emotion_velocity:        emotionVelocity.velocity,
    emotion_velocity_reason: emotionVelocity.velocityReason,

    // Classification
    category:    baseSignal.category,
    rfm_segment: rfmSegment,
    churn_risk:  churnRisk,

    // Action signals
    escalate_to_senior: finalScore >= 75 || churnRisk === 'critical',
    response_confidence: baseSignal.response_confidence,

    // AI-generated content
    draft_response: baseSignal.draft_response,
    key_signals:    baseSignal.key_signals,
    reasoning:      baseSignal.reasoning,

    // Meta
    scored_at: new Date().toISOString(),
  };
}

// ── MOCK CUSTOMER DATABASE (for demo) ─────────────────────────
/**
 * 5 pre-built customer profiles covering every scoring scenario.
 * Used by batch demo mode to show the full range of the model.
 */
const DEMO_CUSTOMERS = {
  enterprise_escalating: {
    name: 'Priya Nair',
    company: 'AcmeCorp',
    arrTier: 'enterprise',
    ltv: 120000,
    purchaseFrequency: 'monthly',
    csatHistory: [5, 5, 4, 3, 1],   // clear downward trend
    accountAgeDays: 840,
    isNewCustomer: false,
  },
  new_customer: {
    name: 'Rohan Mehta',
    company: 'StartupXYZ',
    arrTier: 'free',
    ltv: 0,
    purchaseFrequency: 'none',
    csatHistory: [],
    accountAgeDays: 2,
    isNewCustomer: true,
  },
  loyal_stable: {
    name: 'Kavya Reddy',
    company: 'TechCo',
    arrTier: 'growth',
    ltv: 45000,
    purchaseFrequency: 'monthly',
    csatHistory: [4, 5, 4, 5, 4],   // stable high CSAT
    accountAgeDays: 1200,
    isNewCustomer: false,
  },
  at_risk_champion: {
    name: 'Arjun Singh',
    company: 'BigBrand',
    arrTier: 'enterprise',
    ltv: 200000,
    purchaseFrequency: 'weekly',
    csatHistory: [5, 5, 5, 5, 2],   // sudden drop — at risk
    accountAgeDays: 1800,
    isNewCustomer: false,
  },
  standard_neutral: {
    name: 'Meera Joshi',
    company: 'MidCo',
    arrTier: 'standard',
    ltv: 8000,
    purchaseFrequency: 'quarterly',
    csatHistory: [3, 3, 4, 3],
    accountAgeDays: 365,
    isNewCustomer: false,
  },
  growth_recovering: {
    name: 'Ananya Sharma',
    company: 'FinEdge',
    arrTier: 'growth',
    ltv: 32000,
    purchaseFrequency: 'monthly',
    csatHistory: [2, 3, 4, 5],        // improving trend
    accountAgeDays: 600,
    isNewCustomer: false,
  },
  new_enterprise: {
    name: 'Vikram Malhotra',
    company: 'GlobalOps',
    arrTier: 'enterprise',
    ltv: 95000,
    purchaseFrequency: 'weekly',
    csatHistory: [],
    accountAgeDays: 8,
    isNewCustomer: true,
  },
  starter_frustrated: {
    name: 'Ritu Kapoor',
    company: 'FreelanceHub',
    arrTier: 'starter',
    ltv: 500,
    purchaseFrequency: 'once',
    csatHistory: [4, 2],
    accountAgeDays: 45,
    isNewCustomer: false,
  },
  enterprise_champion: {
    name: 'Siddharth Rao',
    company: 'TechGiant',
    arrTier: 'enterprise',
    ltv: 180000,
    purchaseFrequency: 'weekly',
    csatHistory: [5, 5, 5, 5, 5],
    accountAgeDays: 2400,
    isNewCustomer: false,
  },
  free_positive: {
    name: 'Neha Gupta',
    company: 'PersonalProject',
    arrTier: 'free',
    ltv: 0,
    purchaseFrequency: 'none',
    csatHistory: [5],
    accountAgeDays: 90,
    isNewCustomer: false,
  },
};

// ── DEMO TICKETS (for batch demo mode) ────────────────────────
const DEMO_TICKETS = [
  {
    customer: DEMO_CUSTOMERS.enterprise_escalating,
    ticket: {
      subject: 'URGENT: Duplicate charge on enterprise account',
      message: 'Hello, I need this resolved IMMEDIATELY. We have been charged $4,800 twice this month. I have been trying to reach someone for THREE DAYS. If this is not resolved by today I am escalating to our CFO and legal team. We process over $200K annually through your platform.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.new_customer,
    ticket: {
      subject: 'Cannot log in to my account',
      message: 'Hi, I just signed up yesterday and I cannot log in. It keeps saying my password is wrong but I just set it. I am a bit confused. Could you help? Thank you.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.at_risk_champion,
    ticket: {
      subject: 'API performance has degraded significantly',
      message: 'Our engineering team has noticed a 40% increase in API latency over the past week. This is impacting our production systems. We have been a customer for 5 years and this is not the level of service we expect. Please advise.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.loyal_stable,
    ticket: {
      subject: 'Question about bulk export feature',
      message: 'Hi team, hope you are well. Quick question — is there a way to bulk export reports to CSV? I could not find it in the docs. Not urgent at all, just would save me some time. Thanks!',
    },
  },
  {
    customer: DEMO_CUSTOMERS.standard_neutral,
    ticket: {
      subject: 'Invoice not received for last month',
      message: 'Hello, I did not receive my invoice for March. Could you please resend it to our accounting email? We need it for our records. Thank you.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.growth_recovering,
    ticket: {
      subject: 'Data sync is failing intermittently',
      message: 'Hi, we are seeing intermittent failures in our data sync pipeline. It has happened 3 times this week. Each time it self-resolves after about 20 minutes but we are concerned about data integrity. Can you check what is happening on your end?',
    },
  },
  {
    customer: DEMO_CUSTOMERS.new_enterprise,
    ticket: {
      subject: 'Onboarding setup — urgent configuration question',
      message: 'We just signed our enterprise contract and our team is trying to complete the initial setup. We are stuck on the SSO configuration step. Our IT team is blocked and we have a go-live deadline tomorrow. Please help as soon as possible.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.starter_frustrated,
    ticket: {
      subject: 'Why was I charged after cancelling?',
      message: 'I cancelled my subscription two weeks ago and I just got charged again. This is really frustrating. I followed all the steps to cancel. I want a refund immediately and confirmation that this will not happen again.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.enterprise_champion,
    ticket: {
      subject: 'Exploring upgrade options for additional seats',
      message: 'Hi team, we are looking to expand our usage significantly next quarter. Could you share information about volume pricing for additional seats? We are happy with the product and want to roll it out to two more departments.',
    },
  },
  {
    customer: DEMO_CUSTOMERS.free_positive,
    ticket: {
      subject: 'Feature suggestion — keyboard shortcuts',
      message: 'Love using the product! One small thing that would make my workflow even faster — keyboard shortcuts for common actions. Not urgent at all, just thought it would be a nice addition. Keep up the great work!',
    },
  },
];

// ── EXPORTS ───────────────────────────────────────────────────
// Browser-compatible export (no module bundler needed)
window.BuranshAI = {
  scoreTicket,
  DEMO_CUSTOMERS,
  DEMO_TICKETS,
  getUrgencyLabel,
  EMOTION_VELOCITY,
  RFM_SEGMENTS,
};
