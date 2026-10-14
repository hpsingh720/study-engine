// Systems and starting topic syllabus (MBBS finals + AMC Part 1).
// Format: "Topic name|search keyword;keyword;..."  — you can add/remove topics inside the app.
const SEED_VERSION = 1;
const SEED = {
  systems: [
    { code: 'CVS', name: 'Cardiology', topics: [
      'Acute coronary syndrome (STEMI/NSTEMI)|myocardial infarction;stemi;nstemi;acute coronary syndrome;troponin;unstable angina',
      'Stable angina & chronic coronary disease|stable angina;angina pectoris;coronary artery disease',
      'Heart failure|heart failure;cardiac failure;ejection fraction;natriuretic',
      'Atrial fibrillation & flutter|atrial fibrillation;atrial flutter;cha2ds2',
      'Other arrhythmias & heart block|supraventricular tachycardia;ventricular tachycardia;heart block;bradycardia;long qt',
      'Hypertension|hypertension;antihypertensive;blood pressure',
      'Valvular heart disease|aortic stenosis;aortic regurgitation;mitral stenosis;mitral regurgitation',
      'Infective endocarditis|infective endocarditis;duke criteria',
      'Rheumatic fever & rheumatic heart disease|rheumatic fever;rheumatic heart disease',
      'Pericarditis & cardiac tamponade|pericarditis;cardiac tamponade;pericardial effusion',
      'Cardiomyopathy & myocarditis|cardiomyopathy;myocarditis',
      'Dyslipidaemia & cardiovascular risk|dyslipidaemia;hypercholesterolaemia;statin;cardiovascular risk',
      'Congenital heart disease|ventricular septal defect;atrial septal defect;tetralogy of fallot;patent ductus;coarctation',
      'Aortic dissection & aneurysm|aortic dissection;abdominal aortic aneurysm',
      'Peripheral arterial disease|peripheral arterial disease;claudication;limb ischaemia'
    ]},
    { code: 'RESP', name: 'Respiratory', topics: [
      'Asthma|asthma;bronchospasm;salbutamol;inhaled corticosteroid',
      'COPD|chronic obstructive pulmonary;copd;emphysema;chronic bronchitis',
      'Community-acquired pneumonia|pneumonia;curb-65;smart-cop',
      'Tuberculosis|tuberculosis;mycobacterium;latent tb',
      'Pulmonary embolism & VTE|pulmonary embolism;deep vein thrombosis;venous thromboembolism;wells score',
      'Lung cancer|lung cancer;bronchial carcinoma;small cell;non-small cell',
      'Pleural effusion & pneumothorax|pleural effusion;pneumothorax;empyema',
      'Interstitial lung disease & sarcoidosis|interstitial lung disease;pulmonary fibrosis;sarcoidosis',
      'Bronchiectasis & cystic fibrosis|bronchiectasis;cystic fibrosis',
      'Obstructive sleep apnoea|obstructive sleep apnoea;sleep apnea',
      'Respiratory failure & blood gases|respiratory failure;arterial blood gas;hypoxaemia;hypercapnia',
      'Occupational lung disease|asbestosis;pneumoconiosis;silicosis;mesothelioma'
    ]},
    { code: 'GIT', name: 'Gastro & Hepatology', topics: [
      "GORD & Barrett's oesophagus|gastro-oesophageal reflux;barrett;reflux oesophagitis",
      'Peptic ulcer & H. pylori|peptic ulcer;helicobacter;duodenal ulcer;gastric ulcer',
      'Upper GI bleeding|upper gastrointestinal bleeding;haematemesis;oesophageal varices;melaena',
      'Inflammatory bowel disease|crohn;ulcerative colitis;inflammatory bowel',
      'Coeliac disease & malabsorption|coeliac;malabsorption;gluten',
      'Irritable bowel syndrome|irritable bowel',
      'Viral hepatitis|hepatitis b;hepatitis c;hepatitis a;viral hepatitis',
      'Cirrhosis & portal hypertension|cirrhosis;portal hypertension;ascites;hepatic encephalopathy',
      'Alcohol-related & fatty liver disease|alcoholic liver;fatty liver;steatohepatitis;masld',
      'Pancreatitis|acute pancreatitis;chronic pancreatitis;lipase',
      'Jaundice & liver function tests|jaundice;bilirubin;liver function tests',
      'Colorectal cancer|colorectal cancer;bowel cancer;colonoscopy',
      'Gastroenteritis & diarrhoea|gastroenteritis;diarrhoea;clostridioides',
      'Dysphagia & oesophageal cancer|dysphagia;oesophageal cancer;achalasia'
    ]},
    { code: 'RENAL', name: 'Renal & Urology', topics: [
      'Acute kidney injury|acute kidney injury;acute renal failure',
      'Chronic kidney disease|chronic kidney disease;egfr;dialysis;renal replacement',
      'Glomerulonephritis|glomerulonephritis;nephritic syndrome;iga nephropathy',
      'Nephrotic syndrome|nephrotic syndrome;proteinuria;minimal change',
      'Sodium & potassium disorders|hyponatraemia;hypernatraemia;hyperkalaemia;hypokalaemia',
      'Acid–base disorders|metabolic acidosis;metabolic alkalosis;anion gap',
      'Urinary tract infection|urinary tract infection;pyelonephritis;cystitis',
      'Renal stones|renal calculi;nephrolithiasis;renal colic;ureteric',
      'Polycystic kidney disease|polycystic kidney',
      'BPH & prostate cancer|benign prostatic;prostate cancer;prostate specific antigen',
      'Haematuria & urological cancers|haematuria;bladder cancer;renal cell carcinoma',
      'Scrotal conditions & testicular torsion|testicular torsion;testicular tumour;hydrocele;varicocele'
    ]},
    { code: 'ENDO', name: 'Endocrine & Diabetes', topics: [
      'Type 1 diabetes & DKA|type 1 diabetes;diabetic ketoacidosis',
      'Type 2 diabetes|type 2 diabetes;metformin;hba1c;sglt2',
      'Diabetes complications, HHS & hypoglycaemia|diabetic retinopathy;diabetic nephropathy;hyperosmolar;hypoglycaemia;diabetic foot',
      'Hypothyroidism|hypothyroidism;thyroxine;hashimoto',
      "Hyperthyroidism & Graves' disease|hyperthyroidism;graves;thyrotoxicosis;thyroid storm",
      'Thyroid nodules & cancer|thyroid nodule;thyroid cancer;goitre',
      "Cushing's & adrenal insufficiency|cushing;addison;adrenal insufficiency;cortisol",
      'Hyperaldosteronism & phaeochromocytoma|aldosteronism;phaeochromocytoma',
      'Calcium & parathyroid disorders|hypercalcaemia;hyperparathyroidism;hypocalcaemia',
      'Pituitary disorders|pituitary;prolactinoma;acromegaly;diabetes insipidus',
      'Osteoporosis & metabolic bone disease|osteoporosis;osteomalacia;vitamin d;paget',
      'Obesity & metabolic syndrome|obesity;metabolic syndrome'
    ]},
    { code: 'NEURO', name: 'Neurology', topics: [
      'Stroke & TIA|stroke;transient ischaemic attack;thrombolysis;thrombectomy',
      'Subarachnoid & intracranial haemorrhage|subarachnoid haemorrhage;intracerebral haemorrhage;subdural haematoma;extradural haematoma',
      'Epilepsy & seizures|epilepsy;seizure;status epilepticus',
      'Headache & migraine|headache;migraine;cluster headache;tension-type',
      'Meningitis & encephalitis|meningitis;encephalitis',
      "Parkinson's & movement disorders|parkinson;tremor;chorea;huntington",
      'Multiple sclerosis|multiple sclerosis;demyelination;optic neuritis',
      'Peripheral neuropathy & Guillain–Barré|peripheral neuropathy;guillain;polyneuropathy',
      'Myasthenia gravis & motor neurone disease|myasthenia;motor neurone disease;muscular dystrophy',
      'Dementia & delirium|dementia;alzheimer;delirium',
      'Spinal cord compression & cauda equina|spinal cord compression;cauda equina',
      'Brain tumours & raised ICP|brain tumour;intracranial pressure;glioma;glioblastoma',
      'Head injury|head injury;glasgow coma;traumatic brain injury'
    ]},
    { code: 'HAEM', name: 'Haematology & Oncology', topics: [
      'Iron deficiency & microcytic anaemia|iron deficiency;microcytic;thalassaemia;ferritin',
      'Macrocytic & haemolytic anaemia|vitamin b12;folate deficiency;haemolytic anaemia;macrocytic',
      'Sickle cell & haemoglobinopathies|sickle cell;haemoglobinopathy',
      'Leukaemias|leukaemia;acute myeloid;acute lymphoblastic;chronic lymphocytic;chronic myeloid',
      'Lymphomas|lymphoma;hodgkin',
      'Multiple myeloma|multiple myeloma;paraprotein',
      'Bleeding disorders & thrombocytopenia|haemophilia;von willebrand;thrombocytopenia;immune thrombocytopenia',
      'Anticoagulation & thrombophilia|anticoagulant;warfarin;heparin;thrombophilia;doac',
      'Blood transfusion|blood transfusion;transfusion reaction',
      'Oncological emergencies & palliative care|febrile neutropenia;tumour lysis;malignant spinal cord compression;palliative'
    ]},
    { code: 'ID', name: 'Infectious Diseases', topics: [
      'Sepsis & septic shock|sepsis;septic shock',
      'HIV|hiv;antiretroviral;aids',
      'Malaria, dengue & travel medicine|malaria;dengue;typhoid;returned traveller',
      'Sexually transmitted infections|sexually transmitted;chlamydia;gonorrhoea;syphilis',
      'Immunisation|immunisation;vaccination;vaccine',
      'Antibiotic principles & stewardship|antibiotic;antimicrobial resistance;stewardship',
      'Skin & soft-tissue infections|cellulitis;abscess;necrotising fasciitis',
      'Glandular fever & viral exanthems|infectious mononucleosis;epstein-barr;measles;varicella;rubella',
      'Notifiable diseases & infection control|notifiable disease;infection control;outbreak'
    ]},
    { code: 'MSK', name: 'Rheumatology & MSK', topics: [
      'Rheumatoid arthritis|rheumatoid arthritis',
      'Osteoarthritis|osteoarthritis',
      'Gout & pseudogout|gout;pseudogout;urate',
      'Septic arthritis|septic arthritis',
      'SLE & connective tissue disease|systemic lupus;scleroderma;systemic sclerosis;sjogren',
      'Vasculitis, PMR & giant cell arteritis|vasculitis;polymyalgia rheumatica;giant cell arteritis',
      'Spondyloarthropathies|ankylosing spondylitis;psoriatic arthritis;reactive arthritis',
      'Low back pain|low back pain;sciatica;red flags',
      'Fibromyalgia & soft-tissue rheumatism|fibromyalgia;tendinopathy;bursitis'
    ]},
    { code: 'DERM', name: 'Dermatology', topics: [
      'Eczema & dermatitis|eczema;atopic dermatitis;contact dermatitis',
      'Psoriasis|psoriasis',
      'Skin cancer: melanoma, BCC, SCC|melanoma;basal cell carcinoma;squamous cell carcinoma;skin cancer',
      'Acne & rosacea|acne;rosacea;isotretinoin',
      'Urticaria & severe drug reactions|urticaria;stevens-johnson;drug eruption',
      'Skin infections & infestations|tinea;scabies;impetigo;head lice',
      'Blistering disorders|pemphigus;pemphigoid'
    ]},
    { code: 'SURG', name: 'General Surgery', topics: [
      'Acute abdomen|acute abdomen;peritonitis;abdominal pain',
      'Appendicitis|appendicitis',
      'Gallstone disease|cholecystitis;gallstones;cholangitis;biliary colic',
      'Bowel obstruction|bowel obstruction;volvulus;adhesions',
      'Hernias|hernia;inguinal hernia;femoral hernia',
      'Diverticular disease|diverticulitis;diverticular',
      'Breast lumps & breast cancer|breast cancer;breast lump;fibroadenoma;mastitis',
      'Neck lumps|neck lump;thyroglossal;branchial cyst;lymphadenopathy',
      'Perianal conditions|haemorrhoids;anal fissure;anal fistula;pilonidal',
      'Trauma & primary survey|trauma;primary survey;haemorrhagic shock;atls',
      'Burns|burns;burn injury',
      'Peri-operative care & fluids|preoperative;postoperative complications;fluid management',
      'Vascular emergencies|ruptured aneurysm;acute limb ischaemia',
      'Gastric surgery & perforated ulcer|gastric cancer;perforated peptic ulcer'
    ]},
    { code: 'ORTHO', name: 'Orthopaedics', topics: [
      'Fracture principles & compartment syndrome|fracture healing;compartment syndrome;open fracture',
      'Upper limb fractures|colles fracture;scaphoid fracture;supracondylar fracture;clavicle fracture',
      'Hip & lower limb fractures|neck of femur fracture;hip fracture;ankle fracture;tibial fracture',
      'Knee injuries|anterior cruciate ligament;meniscal tear;knee injury',
      'Shoulder disorders|rotator cuff;frozen shoulder;shoulder dislocation',
      'Paediatric orthopaedics|developmental dysplasia of the hip;perthes;slipped capital femoral;irritable hip',
      'Osteomyelitis & bone tumours|osteomyelitis;osteosarcoma;bone tumour',
      'Hand & wrist conditions|carpal tunnel;trigger finger;dupuytren;de quervain'
    ]},
    { code: 'OBS', name: 'Obstetrics', topics: [
      'Antenatal care & screening|antenatal care;prenatal screening;nuchal translucency;first trimester screening',
      'Early pregnancy problems & miscarriage|miscarriage;hyperemesis;early pregnancy bleeding',
      'Ectopic pregnancy|ectopic pregnancy',
      'Hypertension in pregnancy & pre-eclampsia|pre-eclampsia;eclampsia;gestational hypertension;hellp',
      'Gestational diabetes|gestational diabetes',
      'Antepartum haemorrhage|placenta praevia;placental abruption;antepartum haemorrhage',
      'Preterm labour & PROM|preterm labour;premature rupture of membranes',
      'Normal & abnormal labour|labour;partogram;caesarean section;instrumental delivery;malpresentation',
      'Postpartum haemorrhage|postpartum haemorrhage',
      'Puerperium & postnatal care|puerperium;breastfeeding;postnatal depression;mastitis',
      'Rh isoimmunisation|rhesus;anti-d',
      'Infections in pregnancy|group b streptococcus;rubella in pregnancy;cytomegalovirus;toxoplasmosis',
      'Fetal growth & multiple pregnancy|fetal growth restriction;twin pregnancy;small for gestational age'
    ]},
    { code: 'GYN', name: 'Gynaecology', topics: [
      'Menstrual disorders & abnormal uterine bleeding|heavy menstrual bleeding;amenorrhoea;abnormal uterine bleeding;dysmenorrhoea',
      'Polycystic ovary syndrome|polycystic ovary',
      'Endometriosis & fibroids|endometriosis;fibroids;leiomyoma;adenomyosis',
      'Contraception|contraception;contraceptive pill;intrauterine device;emergency contraception',
      'Infertility|infertility;subfertility',
      'Menopause & HRT|menopause;menopausal hormone therapy;hormone replacement',
      'Cervical screening & cervical cancer|cervical screening;cervical cancer;human papillomavirus;colposcopy',
      'Ovarian masses & ovarian cancer|ovarian cyst;ovarian cancer;ovarian torsion;ca-125',
      'Endometrial cancer & postmenopausal bleeding|endometrial cancer;postmenopausal bleeding',
      'PID & vaginal discharge|pelvic inflammatory disease;vaginal discharge;bacterial vaginosis;candidiasis',
      'Prolapse & urinary incontinence|uterine prolapse;pelvic organ prolapse;urinary incontinence'
    ]},
    { code: 'PAEDS', name: 'Paediatrics', topics: [
      'Neonatal care & neonatal jaundice|neonatal jaundice;newborn;apgar;neonatal resuscitation',
      'Growth, development & failure to thrive|developmental milestones;failure to thrive;short stature',
      'Childhood immunisation schedule|immunisation schedule;childhood vaccination',
      'Febrile child & febrile seizures|febrile seizure;febrile convulsion;fever in children',
      'Bronchiolitis, croup & childhood asthma|bronchiolitis;croup;wheeze in children',
      'Paediatric surgical gut: pyloric stenosis & intussusception|pyloric stenosis;intussusception;malrotation',
      'Childhood rashes & Kawasaki disease|kawasaki;scarlet fever;hand foot and mouth;exanthem',
      'Genetic syndromes|down syndrome;turner syndrome;fragile x',
      'Child protection|child abuse;non-accidental injury;child protection',
      'Dehydration & paediatric emergencies|dehydration in children;paediatric resuscitation',
      'ADHD & autism|attention deficit;autism spectrum',
      'UTI & renal problems in children|urinary tract infection in children;vesicoureteric reflux'
    ]},
    { code: 'PSYCH', name: 'Psychiatry', topics: [
      'Depression|major depressive;depression;antidepressant',
      'Bipolar disorder|bipolar;mania;lithium',
      'Schizophrenia & psychosis|schizophrenia;psychosis;antipsychotic',
      'Anxiety disorders, OCD & PTSD|generalised anxiety;panic disorder;obsessive-compulsive;post-traumatic stress',
      'Suicide risk assessment|suicide;self-harm;risk assessment',
      'Alcohol & substance use|alcohol withdrawal;substance use;opioid dependence',
      'Eating disorders|anorexia nervosa;bulimia nervosa',
      'Personality disorders|personality disorder',
      'Mental health law & capacity|mental health act;involuntary treatment;capacity',
      'Child & adolescent psychiatry|adolescent mental health;conduct disorder'
    ]},
    { code: 'EMERG', name: 'Emergency & Toxicology', topics: [
      'Basic & advanced life support|cardiac arrest;cardiopulmonary resuscitation;advanced life support',
      'Anaphylaxis|anaphylaxis;adrenaline',
      'Paracetamol & common poisonings|paracetamol overdose;poisoning;tricyclic;organophosphate',
      'Snake & spider bites (Australia)|snake bite;spider bite;envenomation;antivenom',
      'Shock & fluid resuscitation|shock;fluid resuscitation',
      'Environmental emergencies|hypothermia;heat stroke;drowning'
    ]},
    { code: 'EYEENT', name: 'Eye & ENT', topics: [
      'Red eye|red eye;conjunctivitis;uveitis;acute angle-closure',
      'Sudden visual loss|retinal detachment;central retinal artery;sudden visual loss',
      'Cataract & glaucoma|cataract;glaucoma',
      'Diabetic & hypertensive retinopathy|diabetic retinopathy;hypertensive retinopathy',
      'Otitis media & otitis externa|otitis media;otitis externa',
      'Hearing loss & vertigo|hearing loss;vertigo;meniere;benign paroxysmal positional',
      'Sore throat & tonsillitis|tonsillitis;pharyngitis;quinsy',
      'Epistaxis & sinusitis|epistaxis;sinusitis',
      'Head & neck cancer|head and neck cancer;laryngeal cancer;oral cancer'
    ]},
    { code: 'ETHICS', name: 'Ethics & Population Health', topics: [
      'Consent & capacity|informed consent;capacity;competence',
      'Confidentiality & mandatory reporting|confidentiality;mandatory reporting;privacy',
      'Professionalism & open disclosure|professionalism;open disclosure;medical error',
      'Aboriginal & Torres Strait Islander health|aboriginal;torres strait islander;indigenous health',
      'Screening & preventive health|screening;preventive health;red book',
      'Evidence-based medicine & biostatistics|sensitivity;specificity;relative risk;number needed to treat;predictive value',
      'Fitness to drive|fitness to drive;driving;austroads',
      'End-of-life care & advance care planning|end of life;advance care directive;palliative care'
    ]}
  ]
};

function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function seedTopics() {
  const out = [];
  SEED.systems.forEach(sys => {
    sys.topics.forEach((line, i) => {
      const [name, kw] = line.split('|');
      out.push({
        id: sys.code.toLowerCase() + '-' + slugify(name),
        system: sys.code, name, kw: (kw || '').split(';').map(s => s.trim()).filter(Boolean),
        order: i, done: 0, doneAt: null, custom: 0
      });
    });
  });
  return out;
}
