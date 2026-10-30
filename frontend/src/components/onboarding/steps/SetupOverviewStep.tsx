import React, { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function SetupOverviewStep() {
  const { goNext, completeOnboarding } = useOnboarding();
  const [isMac, setIsMac] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    checkPlatform();
  }, []);

  const steps = [
    {
      number: 1,
      type: 'transcription',
      title: 'Download Transcription Engine',
    },
    {
      number: 2,
      type: 'summarization',
      title: 'Download Summarization Engine',
    },
  ];

  const handleContinue = () => {
    goNext();
  };

  const handleConfigureLater = async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    setError(null);
    try {
      await completeOnboarding({ configureLater: true });
      window.location.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not finish setup. Please try again.');
      setIsCompleting(false);
    }
  };

  return (
    <OnboardingContainer
      title="Setup Overview"
      description="Choose local model downloads now, or open the app and configure models later in Settings."
      step={2}
      totalSteps={isMac ? 4 : 3}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Steps Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-4">
          <div className="space-y-4">
            {steps.map((step, idx) => {
              return (
                <div
                  key={step.number}
                  className={`flex items-start gap-4 p-1`}
                >
                  <div className="flex-1 ml-1">
                    <h3 className="font-medium text-gray-900 flex items-center gap-2">
                        Step {step.number} :  {step.title}

                        {step.type === "summarization" && (
                            <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                <button className="text-gray-400 hover:text-gray-600">
                                    <Info className="w-4 h-4" />
                                </button>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-sm">
                                You can also select external AI providers like OpenAI, Claude, or
                                Ollama for summary generation in settings.
                                </TooltipContent>
                            </Tooltip>
                            </TooltipProvider>
                        )}
                        </h3>
                  </div>
                </div>
              );
            })}
          </div>
        </div>


        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-4">
          <p className="text-sm text-gray-600">
            For Chinese transcription, choose multilingual Whisper in Settings.
            Parakeet does not support Chinese. The download option below installs
            Parakeet (~640 MB) and a recommended local summary model (about 1–3 GB).
            You can also configure your own summary API in Settings.
          </p>
          <Button onClick={handleConfigureLater} disabled={isCompleting} className="w-full h-auto min-h-11 whitespace-normal">
            {isCompleting ? 'Opening…' : 'Configure models later — open without downloading'}
          </Button>
          <Button
            onClick={handleContinue}
            disabled={isCompleting}
            variant="outline"
            className="w-full h-auto min-h-11 whitespace-normal"
          >
            Download Parakeet + summary models
          </Button>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="text-center">
            <a
              href="https://github.com/Zackriya-Solutions/meeting-minutes"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-600 hover:underline"
            >
              Report issues on GitHub
            </a>
          </div>
        </div>
      </div>
    </OnboardingContainer>
  );
}
