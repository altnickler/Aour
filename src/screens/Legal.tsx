import { PageHeader } from '@/components/ui'

/**
 * PLACEHOLDER legal pages. Have these reviewed by a lawyer before public launch and keep
 * them consistent with the App Store privacy "nutrition label" (see IOS_RELEASE_PLAN.md).
 */
export default function LegalScreen({ doc }: { doc: 'privacy' | 'terms' }) {
  return (
    <div>
      <PageHeader title={doc === 'privacy' ? 'Privacy policy' : 'Terms of service'} back />
      <article className="prose-sm space-y-4 px-5 pb-12 text-[15px] leading-relaxed text-espresso [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-extrabold [&_h2]:text-choc">
        <p className="rounded-tile bg-butter-soft p-3 text-sm text-choc">
          Draft placeholder — not yet reviewed by counsel. Last updated {new Date(2026, 9, 15).toLocaleDateString()}.
        </p>
        {doc === 'privacy' ? <Privacy /> : <Terms />}
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
        <li><b>Location:</b> only if you choose “Use my location”. It is rounded to about 1 km, used on your device to sort by distance, and never stored on our servers.</li>
        <li><b>Usage:</b> privacy-friendly, cookie-free page analytics and error reports to keep the app working.</li>
      </ul>
      <h2>What others can see</h2>
      <p>With a public profile, people can see your profile, public ratings, reviews, favorites and public collections. Private ratings, private notes and private collections are visible only to you. You can make your whole profile private in Settings.</p>
      <h2>Community scores</h2>
      <p>Unless you turn it off in Settings, your scores are included anonymously in each place’s community averages.</p>
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
