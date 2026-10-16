import { PageHeader } from '@/components/ui'

/**
 * PLACEHOLDER legal pages. Have these reviewed by a lawyer before public launch and keep
 * them consistent with the App Store privacy "nutrition label" (see IOS_RELEASE_PLAN.md).
 */
const TITLE = { privacy: 'Privacy policy', terms: 'Terms of service', bot: 'AourBot' } as const

export default function LegalScreen({ doc }: { doc: 'privacy' | 'terms' | 'bot' }) {
  return (
    <div>
      <PageHeader title={TITLE[doc]} back />
      <article className="prose-sm space-y-4 px-5 pb-12 text-[15px] leading-relaxed text-espresso [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-extrabold [&_h2]:text-choc">
        <p className="rounded-tile bg-butter-soft p-3 text-sm text-choc">
          Draft placeholder — not yet reviewed by counsel. Last updated {new Date(2026, 9, 15).toLocaleDateString()}.
        </p>
        {doc === 'privacy' ? <Privacy /> : doc === 'bot' ? <Bot /> : <Terms />}
      </article>
    </div>
  )
}

function Privacy() {
  return (
    <>
      <h2>What we collect</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li><b>Account:</b> your email address (for sign-in codes), username, display name, and optional photo, bio and home city.</li>
        <li><b>Your content:</b> ratings, tags, reviews, private notes, photos, lists, collections and follows.</li>
        <li><b>Location:</b> only if you choose “Use my location”. It is rounded to about 1 km, used on your device to find nearby places, and never stored on our servers. Nearby searches send that rounded point, not your exact position.</li>
        <li><b>Place searches:</b> city or address searches pass through our server to a geocoding service (Photon, built on OpenStreetMap) and are not saved to your account. If we have no listings where you search and you tap “Bring Aour here”, we record only an area rounded to about 11 km, with no link to you.</li>
        <li><b>Usage:</b> privacy-friendly, cookie-free page analytics and error reports to keep the app working.</li>
      </ul>
      <h2>What others can see</h2>
      <p>With a public profile, people can see your profile, public ratings, reviews, favorites and public collections. Private ratings, private notes and private collections are visible only to you. You can make your whole profile private in Settings.</p>
      <h2>Community scores</h2>
      <p>Unless you turn it off in Settings, the scores from your <b>public</b> ratings are included anonymously in each place’s community averages. Private ratings are never included.</p>
      <h2>Sharing</h2>
      <p>We don’t sell your personal information or share it with advertisers. We use service providers (hosting, database, email delivery) who process data on our behalf.</p>
      <h2>Your choices</h2>
      <p>You can edit or delete any rating at any time, and permanently delete your account and all associated data from Settings → Delete account.</p>
      <h2>Contact</h2>
      <p>privacy@aour.app</p>
    </>
  )
}

function Terms() {
  return (
    <>
      <h2>Using Aour</h2>
      <p>Aour helps you discover, rate and remember happy hours. You must be of legal drinking age in your location to use Aour. Please drink responsibly and never drink and drive.</p>
      <h2>Listings</h2>
      <p>Happy-hour times and specials change. We show when each listing was last verified, but we can’t guarantee accuracy — check with the venue before you go.</p>
      <h2>Your content</h2>
      <p>You own what you post. You give Aour permission to display it in the app according to your privacy settings. Don’t post content that is false, hateful, harassing, spammy or that you don’t have rights to (including photos).</p>
      <h2>Moderation</h2>
      <p>We may hide or remove content and suspend accounts that break these rules or abuse the service.</p>
      <h2>Contact</h2>
      <p>hello@aour.app</p>
    </>
  )
}

/** Public page for the user agent "AourBot/1.0 (+https://aour.app/bot)". */
function Bot() {
  return (
    <>
      <p>AourBot is Aour’s crawler. It reads a venue’s <b>own website</b> to keep its happy-hour times and specials up to date, so people visiting the venue have accurate information.</p>
      <h2>How it behaves</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>It obeys robots.txt, including rules for the user agent <code>AourBot</code> and <code>Crawl-delay</code>.</li>
        <li>It requests at most one page every few seconds per site, and usually only the homepage and a happy-hour or specials page, every few weeks.</li>
        <li>It never logs in, never solves CAPTCHAs and stops when a site rate-limits or blocks it.</li>
        <li>It keeps only the facts (days, times, specials, prices and a short supporting quote), not copies of your pages or images.</li>
      </ul>
      <h2>Opting out</h2>
      <p>Add <code>User-agent: AourBot</code> / <code>Disallow: /</code> to your robots.txt, or email <b>bot@aour.app</b>. Venue owners can also email us to correct or update their happy hour directly.</p>
    </>
  )
}
