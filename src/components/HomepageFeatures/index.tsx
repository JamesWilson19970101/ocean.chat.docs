import type { ReactNode } from "react";
import clsx from "clsx";
import Heading from "@theme/Heading";
import Translate, { translate } from "@docusaurus/Translate";
import styles from "./styles.module.css";

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<"svg">>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: translate({ id: "homepage.feature.secure.title", message: "Secure & Private" }),
    Svg: require("@site/static/img/secure.svg").default,
    description: (
      <Translate id="homepage.feature.secure.description">
        OceanChat provides comprehensive security features and robust privacy
        controls to keep your communications safe and confidential.
      </Translate>
    ),
  },
  {
    title: translate({ id: "homepage.feature.fast.title", message: "Fast & Reliable" }),
    Svg: require("@site/static/img/fast.svg").default,
    description: (
      <Translate id="homepage.feature.fast.description">
        Built on a distributed microservice architecture, OceanChat ensures high
        performance, low latency, and maximum uptime for all your messages.
      </Translate>
    ),
  },
  {
    title: translate({ id: "homepage.feature.extensible.title", message: "Extensible & Open" }),
    Svg: require("@site/static/img/extensible.svg").default,
    description: (
      <Translate id="homepage.feature.extensible.description">
        Customize your experience with our rich APIs and integrations. Easily
        deploy, scale, and manage OceanChat on your own infrastructure.
      </Translate>
    ),
  },
];

function Feature({ title, Svg, description }: FeatureItem) {
  return (
    <div className={clsx("col col--4")}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
