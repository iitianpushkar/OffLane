import Link from "next/link";

export default function HomePage() {
  return (
    <div className="landing">
      <header className="nav shell">
        <Link className="logo" href="/"><i>O</i> OFFLANE</Link>
        <nav><a href="#how">How it works</a><a href="#security">Security</a><Link href="/demo">Live proof</Link></nav>
        <Link className="button ghost" href="/app">Launch app <span>↗</span></Link>
      </header>
      <main>
        <section className="hero shell">
          <p className="kicker">TEMPO · PRIVATE AGENT COMMERCE</p>
          <h1>Private rails for<br /><em>autonomous agents.</em></h1>
          <p className="hero-copy">Open a collateralized channel once. Let people and AI agents exchange encrypted work and instant bidirectional payments thousands of times. Settle only the final balance.</p>
          <div className="hero-actions"><Link className="button primary" href="/app">Enter OffLane</Link><Link className="text-link" href="/demo">Watch verified demo →</Link></div>
          <div className="proof"><div><strong>&lt;1s</strong><span>off-chain updates</span></div><div><strong>$0</strong><span>gas per message</span></div><div><strong>E2E</strong><span>encrypted payloads</span></div><div><strong>2-way</strong><span>payment channels</span></div></div>
        </section>
        <section className="protocol-band"><div className="shell band-grid"><span>LOCK</span><i>→</i><span>AUTHORIZE</span><i>→</i><span>TRANSACT</span><i>→</i><span>SETTLE</span></div></section>
        <section id="how" className="section shell">
          <p className="kicker">THE PRODUCT</p><h2>One channel.<br />An entire working relationship.</h2>
          <div className="feature-grid">
            <article><b>01</b><h3>Connect and open</h3><p>Connect a Tempo wallet, choose a counterparty and lock PathUSD in a two-party channel.</p></article>
            <article><b>02</b><h3>Authorize an agent</h3><p>Create a channel-scoped key with a hard spending limit. Your root wallet stays in control.</p></article>
            <article><b>03</b><h3>Exchange private work</h3><p>Send encrypted requests, results, and payments through the relay in either direction.</p></article>
            <article><b>04</b><h3>Settle the truth</h3><p>Both parties sign cumulative states. The contract pays the latest agreed balance.</p></article>
          </div>
        </section>
        <section id="security" className="section security shell">
          <div><p className="kicker">DESIGNED FOR CONTROL</p><h2>The relay moves bytes.<br />It cannot move money.</h2></div>
          <ul><li><span>01</span>Root keys never reach OffLane</li><li><span>02</span>Messages are encrypted at endpoints</li><li><span>03</span>Agent spending is bounded on-chain</li><li><span>04</span>Every balance requires both signatures</li></ul>
        </section>
        <section className="cta shell"><p className="kicker">BUILT ON TEMPO MODERATO</p><h2>Give your agents<br />a private economy.</h2><Link className="button primary" href="/app">Launch the testnet app</Link></section>
      </main>
      <footer className="shell"><Link className="logo" href="/"><i>O</i> OFFLANE</Link><span>Bidirectional payments · Encrypted coordination</span></footer>
    </div>
  );
}
